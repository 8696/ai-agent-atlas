import { PassThrough } from 'node:stream';
import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { createChatEventStream, createPartsAccumulator, describeError } from '../agent/events.js';
import { registerRequestSignal, unregisterRequestSignal } from '../agent/abort.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../logger.js';
import {
  registerSessionStream,
  streamChatTurn,
  getPendingTurnMessageId,
  unregisterSessionStream,
  type ChatEvent,
} from '../services/chat.js';
import { resolveModel, resolveFallback } from '../services/model.js';
import {
  appendAssistantMessage,
  applyTitleFromFirstUserMessage,
  syncMessages,
} from '../services/message.js';
import { extractText } from '../services/chat-messages.js';
import { resolvePendingDecision } from '../services/pending-confirm.js';
import { findSession, touchSession } from '../services/session.js';
import { parseCommand, runCommand, COMMANDS, skillNames } from '../services/command.js';
import { checkBudget, budgetWarningText } from '../services/cost.js';
import { runMemoryExtraction } from '../services/memory/extract.js';
import { listPersonalities } from '../services/prompt.js';

/**
 * 对话网关 —— `/api/v1/chat`（SSE）+ `/api/v1/chat/confirm`（人工确认）+ `/api/v1/models`。
 *
 * ⚠️ **无鉴权**（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）——
 * 服务默认只听 `127.0.0.1`。
 *
 * ⚠️ **SSE 用 POST + fetch**（不是 `EventSource`）——
 * `EventSource` 不支持 POST 与自定义头（见 [03-c §C.1](../docs/03-c-技术栈-前端栈.md)）。
 */

/** SSE 响应头（与 AI SDK UI Message Stream 一致） */
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
} as const;

const uiPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

const uiMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(uiPartSchema),
});

/** 请求体 —— 前端 `useChat` 默认发 `{ id, messages, trigger, messageId }` */
const chatRequestSchema = z.object({
  id: z.string().optional(),
  messages: z.array(uiMessageSchema),
  trigger: z.string().optional(),
  messageId: z.string().optional(),
  /** 会话 id（**前端建好会话后带进来**；没有就只聊天不落库） */
  sessionId: z.string().optional(),
});

/** 确认请求体 */
const confirmRequestSchema = z.object({
  sessionId: z.string().min(1),
  approved: z.boolean(),
});

export const chatRouter = new Router({ prefix: '/api/v1' });

/** 最后一条用户消息的正文（**斜杠命令要靠它认出来**） */
function lastUserText(
  messages: Array<{
    role: string;
    parts: Array<{ type: string; text?: string | undefined }>;
  }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    return extractText(message.parts);
  }
  return '';
}

/**
 * 把一轮事件流写成 SSE，并落库。
 *
 * 📌 **落库的 parts 与推给前端的是同一份** —— 同一个累加器吃同一批 chunk。
 * 📌 **`makeEvents` 拿得到 abort 信号** —— 客户端断开时上游调用要真的停掉。
 */
function respondWithStream(
  ctx: Context,
  options: {
    /** 造事件流（**信号在里面** —— 断开时要能中止上游调用） */
    makeEvents: (signal: AbortSignal) => AsyncIterable<ChatEvent>;
    /** 外部的控制器（**`/stop` 要靠它中止** —— 不给就自己建一个） */
    controller?: AbortController | undefined;
    messageId: string;
    sessionId?: string | undefined;
    modelName: string;
    /** 附加一条提示（**预算告警之类**） */
    notice?: string | undefined;
    /** 流结束后要做的事（**记忆抽取**） */
    after?: ((text: string) => void) | undefined;
    /** 流彻底结束时调（**注销流登记**） */
    onFinally?: (() => void) | undefined;
  },
): void {
  const abort = options.controller ?? new AbortController();
  const stream = new PassThrough();
  // 客户端断开时写流会 EPIPE —— 吞掉，别让未捕获异常把进程带走
  stream.on('error', () => {});

  // ⚠️ **客户端断开不算错误**（见 [12-b B1](../docs/12-b-需求-对话与编排.md)）：
  //    响应流提前关闭会让 Node 抛 ERR_STREAM_PREMATURE_CLOSE —— 那不是服务故障
  ctx.res.on('error', (err: NodeJS.ErrnoException) => {
    // 📌 **socket 报错也意味着「客户端没了」** —— 断开有时表现为
    //    `error`（ECONNRESET）而不是 `close`；只监听 close 会漏掉，
    //    上游调用就停不下来（白烧 token）
    if (!ctx.res.writableEnded) {
      abort.abort();
      stream.destroy();
    }
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    logger.error({ err, path: ctx.path }, 'response stream error');
  });

  // 客户端断开 → abort 上游调用（**不能只是前端不再收**）
  // ⚠️ 用 `res` 的 close 而不是 `req` 的 —— req 的 close 在请求体读完时就可能触发，
  //    那会把还没开始的模型调用直接掐掉
  ctx.res.on('close', () => {
    if (ctx.res.writableEnded) return;
    abort.abort();
    stream.destroy();
  });

  ctx.set(SSE_HEADERS);
  ctx.status = 200;
  ctx.body = stream;

  // 📌 **登记这轮请求的信号** —— 节点从这儿取（不指望中间层转发）
  registerRequestSignal(options.messageId, abort.signal);

  // ⚠️ **落库的 parts 与推给前端的同源** —— 同一个累加器吃同一批 chunk
  const parts = createPartsAccumulator();

  void (async () => {
    try {
      const source = options.makeEvents(abort.signal);
      const withNotice = options.notice ? prependNotice(source, options.notice) : source;
      for await (const chunk of createChatEventStream({
        events: withNotice,
        messageId: options.messageId,
      })) {
        parts.add(chunk);
        await writeChunk(stream, `data: ${JSON.stringify(chunk)}\n\n`);
        // ⚠️ **挂起时先把部分内容落库** ——
        //    「重启后待确认的卡片还在」靠的就是这一笔
        //    （见 [12-b B5](../docs/12-b-需求-对话与编排.md)）
        if (chunk.type === 'data-pending-confirm' && options.sessionId) {
          try {
            await appendAssistantMessage(options.sessionId, {
              id: options.messageId,
              content: parts.text(),
              parts: parts.parts(),
              metadata: { model: options.modelName, pendingConfirm: true },
            });
          } catch (err) {
            logger.error({ err, sessionId: options.sessionId }, '挂起时落库失败');
          }
        }
      }
    } catch (err) {
      // ⚠️ **客户端断开不算错误**（见 [12-b B1](../docs/12-b-需求-对话与编排.md)）——
      //    那是用户关了标签页，不是服务出错，别刷错误日志
      if (!abort.signal.aborted) {
        // ⚠️ **异常发生在流里，不是 Koa 处理器里** —— 只能变成 error chunk 推给前端
        logger.error({ err, path: ctx.path }, 'chat stream failed');
        stream.write(
          `data: ${JSON.stringify({ type: 'error', errorText: describeError(err) })}\n\n`,
        );
      }
    } finally {
      if (!abort.signal.aborted) {
        stream.write('data: [DONE]\n\n');
      }
      stream.end();

      // ⚠️ **落库在流结束之后** —— 内容与用户看到的逐字一致
      if (options.sessionId) {
        try {
          await appendAssistantMessage(options.sessionId, {
            id: options.messageId,
            content: parts.text(),
            parts: parts.parts(),
            metadata: { model: options.modelName },
          });
        } catch (err) {
          // ⚠️ **落库失败不许打断对话** —— 用户已经看到回答了
          logger.error(
            { err, sessionId: options.sessionId },
            'failed to persist assistant message',
          );
        }
        try {
          await touchSession(options.sessionId);
        } catch (err) {
          logger.error({ err, sessionId: options.sessionId }, 'failed to refresh session counters');
        }
      }

      // 📌 **记忆抽取在流结束之后**（**不阻塞这一轮**）
      //    ⚠️ **客户端断开就不抽了** —— 那一轮没说完，抽出来的多半是半句话
      if (!abort.signal.aborted) options.after?.(parts.text());
      options.onFinally?.();
      unregisterRequestSignal(options.messageId);
    }
  })();
}

/**
 * 往流里写一块。
 *
 * ⚠️ **不能无限等 `drain`** —— 客户端断开时流会被销毁，
 * `drain` 永远不会来（那会让这一轮的落库永远不执行）。
 * 📌 **销毁 / 关闭 / 出错都当「写完了」** —— 外层的 `finally` 负责落库。
 */
async function writeChunk(stream: PassThrough, payload: string): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return;
  let flushed: boolean;
  try {
    flushed = stream.write(payload);
  } catch {
    return;
  }
  if (flushed) return;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    stream.once('drain', done);
    stream.once('close', done);
    stream.once('error', done);
  });
}

/** 在事件流前面插一条提示 */
async function* prependNotice(
  events: AsyncIterable<ChatEvent>,
  notice: string,
): AsyncGenerator<ChatEvent> {
  yield { type: 'notice', text: notice };
  yield* events;
}

/**
 * `POST /api/v1/chat` —— 一轮对话，流式返回。
 *
 * ⚠️ **没配模型 → 503**（不是 500）：这是**运行时状态**，用户要做的是改 `.env` 的
 * `LLM_MODEL`（见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）。
 */
// ⚠️ **这个处理器本身是同步的** —— 它把响应流挂好就返回，
//    真正的流式循环在下面的 `void (async () => {...})()` 里跑（不占着 Koa 的 Promise）。
chatRouter.post('/chat', async (ctx) => {
  const parsed = chatRequestSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', '请求体格式不对', 400);
  }

  const model = resolveModel();

  const sessionId = parsed.data.sessionId;
  if (sessionId) {
    // ⚠️ **会话不存在就直接报错** —— 不静默新建一个，
    //    否则用户删了会话再发消息会「复活」一条空会话
    const session = await findSession(sessionId);
    if (!session) {
      throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
    }
    // ⚠️ **先对账再开流** —— 库里与前端历史对齐（重新生成 = 删掉多余的行）
    await syncMessages(sessionId, parsed.data.messages);
    // ⚠️ **标题在这里定，不在流结束时定** ——
    //    这样即使这一轮流失败了，会话也已经有能看懂的标题
    await applyTitleFromFirstUserMessage(sessionId);
  }

  const userText = lastUserText(parsed.data.messages);
  const command = parseCommand(userText);

  // ── 斜杠命令：**服务端解析，零 LLM 调用** ──
  // ⚠️ **命令不要求配模型** —— `/help` 用不着模型，
  //    「没配模型就什么都干不了」对命令不成立
  if (command) {
    const result = await runCommand(command, { sessionId });
    const assistantMessageId = nanoid();

    respondWithStream(ctx, {
      makeEvents: () =>
        // eslint-disable-next-line @typescript-eslint/require-await -- async generator 的签名要求
        (async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'text-delta', delta: result.text };
          yield {
            type: 'command',
            payload: {
              command: command.name,
              ...(result.action && result.action !== 'none' ? { action: result.action } : {}),
              ...(result.data ? { data: result.data } : {}),
            },
          };
        })(),
      messageId: assistantMessageId,
      ...(sessionId ? { sessionId } : {}),
      modelName: model?.name ?? 'unknown',
    });
    return;
  }

  // ⚠️ **没配模型 → 503**（不是 500）：这是**运行时状态**，用户要做的是改 `.env` 的
  // `LLM_MODEL`（见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）
  if (!model) {
    throw new AppError(
      'MODEL_NOT_CONFIGURED',
      '还没配置模型，去改 .env 的 LLM_MODEL（改完重启后端）',
      503,
    );
  }

  // ── 预算闸（**超预算且开了硬拦 → 不执行**） ──
  const budget = await checkBudget();
  if (budget.blocked) {
    throw new AppError(
      'BUDGET_EXCEEDED',
      `本轮因超出预算未执行 —— 本月已用 ${budget.used} token，预算 ${budget.budget}。` +
        '（改 .env 的 MONTHLY_TOKEN_BUDGET，或把 COST_BUDGET_BLOCK 改成 false）',
      402,
    );
  }
  if (budget.warn) {
    logger.warn({ used: budget.used, budget: budget.budget }, '本月 token 用量超过告警线');
  }

  // ⚠️ **assistant 消息 id 先定下来** —— 图状态、工具流水、落库、
  //    「重启后恢复」用的都是**这一个 id**（三处各生成一个会写成三条消息）
  const assistantMessageId = nanoid();

  // 📌 **登记流** —— `/stop` 要靠它中止正在跑的那一轮
  const controller = new AbortController();
  if (sessionId) registerSessionStream(sessionId, controller);

  respondWithStream(ctx, {
    controller,
    makeEvents: (signal) =>
      streamChatTurn({
        messages: parsed.data.messages,
        ...(sessionId ? { sessionId } : {}),
        messageId: assistantMessageId,
        signal,
      }),
    messageId: assistantMessageId,
    ...(sessionId ? { sessionId } : {}),
    modelName: model.name,
    ...(budget.warn ? { notice: budgetWarningText(budget) } : {}),
    after: (text) => {
      // 📌 **记忆抽取：fire-and-forget**（不阻塞这一轮）
      void runMemoryExtraction({ userText, assistantText: text }).catch((err) => {
        logger.warn({ err }, '记忆抽取失败');
      });
    },
    ...(sessionId ? { onFinally: () => unregisterSessionStream(sessionId) } : {}),
  });
});

/**
 * `POST /api/v1/chat/confirm` —— **人工确认闸的另一半**（见 [12-b B5](../docs/12-b-需求-对话与编排.md)）。
 *
 * 两条路：
 * 1. **进程里有人在等**（正常情况）→ 把决定送过去，**原来的 SSE 继续往下流**
 * 2. **没人等**（后端重启过）→ 自己恢复图，把结果一次性返回
 */
chatRouter.post('/chat/confirm', async (ctx) => {
  const parsed = confirmRequestSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', '请求体格式不对', 400);
  }
  const { sessionId, approved } = parsed.data;

  const session = await findSession(sessionId);
  if (!session) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }

  // ── 路 1：有人在等 ──
  if (resolvePendingDecision(sessionId, { approved })) {
    ctx.body = { ok: true, mode: 'resumed' };
    return;
  }

  // ── 路 2：后端重启过 —— 自己恢复图 ──
  const parts = createPartsAccumulator();
  try {
    const events = streamChatTurn({
      sessionId,
      messageId: nanoid(),
      resume: { approved },
    });
    for await (const chunk of createChatEventStream({ events })) {
      parts.add(chunk);
    }
  } catch (err) {
    logger.error({ err, sessionId }, '恢复被挂起的对话失败');
    throw new AppError('RESUME_FAILED', describeError(err), 500);
  }

  // ⚠️ **续跑的是同一条消息** —— 消息 id 存在检查点里，重启后还是同一个
  const messageId = await getPendingTurnMessageId(sessionId);
  if (messageId) {
    try {
      await appendAssistantMessage(sessionId, {
        id: messageId,
        content: parts.text(),
        parts: parts.parts(),
        metadata: { model: resolveModel()?.name ?? 'unknown' },
      });
    } catch (err) {
      logger.error({ err, sessionId }, '恢复后落库失败');
    }
  }

  ctx.body = { ok: true, mode: 'completed', text: parts.text(), parts: parts.parts() };
});

/**
 * `GET /api/v1/models` —— 当前可用模型。
 *
 * ⚠️ **不回显 API Key**（见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）。
 */
chatRouter.get('/models', (ctx) => {
  const primary = resolveModel();
  const fallback = resolveFallback();
  ctx.body = {
    configured: primary !== undefined,
    models: [
      ...(primary ? [{ name: primary.name, role: 'primary' as const }] : []),
      ...(fallback ? [{ name: fallback.name, role: 'fallback' as const }] : []),
    ],
  };
});

/**
 * `GET /api/v1/commands` —— **斜杠命令清单**（前端补全用）。
 *
 * 📌 **命令在服务端解析** —— 前端只拿清单做补全，不做解析。
 */
chatRouter.get('/commands', (ctx) => {
  ctx.body = {
    commands: COMMANDS.map((command) => ({
      name: command.name,
      usage: command.usage,
      summary: command.summary,
    })),
    skills: skillNames(),
    personalities: listPersonalities(),
  };
});
