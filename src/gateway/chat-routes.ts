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
import { checkBudget } from '../services/cost.js';
import { runMemoryExtraction } from '../services/memory/extract.js';
import { listPersonalities } from '../services/prompt.js';
import { logEvent } from '../services/turn-log/emit.js';
import { finishTurn, startTurn } from '../services/turn-log/store.js';

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
  /**
   * ⚠️ **入参指纹** —— 前端从确认卡片里带回来（**批准的是哪一组参数**）。
   * 后端核对不上就重新弹确认（见 [12-b B5](../docs/12-b-需求-对话与编排.md)）。
   */
  fingerprint: z.string().optional(),
  /**
   * ⚠️ **「本轮剩下的都批准」**（见 [12-b B5](../docs/12-b-需求-对话与编排.md)）——
   * 用户点了「批准并放行本轮剩余的」才会带这个
   */
  approveAll: z.boolean().optional(),
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

  // 📌 **这一轮是「答完了」还是「答到一半」** —— 落库时写进 metadata
  //    ⚠️ **刷新页面时靠它告诉用户「这条没答完」**（见 [12-b B13](../docs/12-b-需求-对话与编排.md)）
  const metadata: Record<string, unknown> = { model: options.modelName, complete: false };

  // 📌 **流式过程中定期落库** ——
  //    ⚠️ **以前只在流结束时落一次**（见下面的 `finally`），
  //    客户端一刷新 / 后端一重启，**整条回答就没了**（库里查无此条）。
  //    现在**说出口就落库**，刷新后至少能看到「答到一半」的内容。
  // 📌 **第一次有内容就落**（别等 2 秒）—— 行得先在库里，
  //    收尾那笔才有得可更新（见下面的 `createIfMissing: false`）。
  // 📌 **计时从这一轮开始** —— 别一收到第一个 chunk 就落：
  //    那时候回答还没成型（工具卡片可能还没到），
  //    库里会留下一条**半成品**（对账与界面都把它当真的）。
  let lastPersistAt = Date.now();
  const persistIntervalMs = 2000;
  /** 正在跑的那次落库（**别并发写同一行**） */
  let persisting: Promise<void> = Promise.resolve();
  /** 这一轮**已经落过库**（**收尾时据此决定「新建」还是「只更新」**） */
  let persisted = false;

  /** 把当前累计到的内容落库（**串行** —— 免得两次写互相覆盖） */
  const persistNow = (): Promise<void> => {
    if (!options.sessionId) return Promise.resolve();
    const snapshot = {
      content: parts.text(),
      parts: parts.parts(),
    };
    // ⚠️ **一个字都没有就别落** ——
    //    空行会让「对账」把刚写的回答当成多出来的行删掉，
    //    也会让「这一轮答完了没有」判错（空行 = 还没开始说）。
    const hasContent =
      snapshot.content.length > 0 ||
      snapshot.parts.some((part) => part.type.startsWith('data-'));
    if (!hasContent) return persisting;
    // 📌 **有内容才重置计时** —— 还没开口就别开始计时，
    //    否则第一个字要等满 2 秒才落库（刷新就丢了）
    lastPersistAt = Date.now();
    persisting = persisting
      .then(() =>
        appendAssistantMessage(options.sessionId as string, {
          id: options.messageId,
          content: snapshot.content,
          parts: snapshot.parts,
          metadata: { ...metadata },
        }),
      )
      .then(() => touchSession(options.sessionId as string))
      .then(() => {
        persisted = true;
      })
      .catch((err: unknown) => {
        logger.error({ err, sessionId: options.sessionId }, '流式落库失败');
      });
    return persisting;
  };

  void (async () => {
    try {
      const source = options.makeEvents(abort.signal);
      for await (const chunk of createChatEventStream({
        events: source,
        messageId: options.messageId,
      })) {
        parts.add(chunk);
        // 📌 **定期落库** —— 已经说出口的内容别只留在内存里
        //    ⚠️ **必须排在写 socket 之前** —— 客户端一断开，写 socket 可能卡住，
        //    那样连这一笔落库都等不到（**整条回答就丢了**）。
        if (options.sessionId && Date.now() - lastPersistAt > persistIntervalMs) {
          void persistNow();
        }
        await writeChunk(stream, `data: ${JSON.stringify(chunk)}\n\n`, abort.signal);
        // ⚠️ **挂起时先把部分内容落库** ——
        //    「重启后待确认的卡片还在」靠的就是这一笔
        //    （见 [12-b B5](../docs/12-b-需求-对话与编排.md)）
        if (chunk.type === 'data-pending-confirm' && options.sessionId) {
          try {
            await appendAssistantMessage(options.sessionId, {
              id: options.messageId,
              content: parts.text(),
              parts: parts.parts(),
              metadata: { ...metadata, pendingConfirm: true },
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
        // 📌 **这一轮出错了** —— 记进会话日志
        //    （见 [12-e E7](../docs/12-e-需求-观测安全与验收.md)）
        if (options.sessionId) {
          logEvent({
            turnId: options.messageId,
            sessionId: options.sessionId,
            type: 'turn.error',
            eventKey: 'turn.error',
            title: '这一轮出错',
            payload: { error: describeError(err) },
          });
        }
      }
    } finally {
      if (!abort.signal.aborted) {
        stream.write('data: [DONE]\n\n');
      }
      stream.end();

      // ⚠️ **落库在流结束之后** —— 内容与用户看到的逐字一致
      if (options.sessionId) {
        // 📌 **先等前面的流式落库写完** —— 别让它们跟这一笔并发（会互相覆盖）
        await persisting.catch(() => undefined);
        // 📌 **这一轮正常跑完了** —— 标记成「完整」
        //    ⚠️ **断开了 / 出错了就是没答完** —— 界面上要标出来
        metadata.complete = !abort.signal.aborted;
        try {
          await appendAssistantMessage(options.sessionId, {
            id: options.messageId,
            content: parts.text(),
            parts: parts.parts(),
            metadata: { ...metadata },
            // 📌 **流式落过库就只更新、不新建** ——
            //    「重新生成」把旧行删掉后，这一轮的收尾不能把它**复活**
            //    （否则库里会多出一条一样的回答）
            createIfMissing: !persisted,
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

      // 📌 **这一轮收尾** —— 状态落库（回答节点也会写一条 `turn.finished` 事件）
      //    ⚠️ **客户端断开算失败** —— 那一轮没说完
      if (options.sessionId) {
        await finishTurn(
          options.messageId,
          abort.signal.aborted ? 'failed' : 'finished',
          options.modelName,
        );
      }
    }
  })();
}

/**
 * 往流里写一块。
 *
 * ⚠️ **不能无限等 `drain`** —— 客户端断开时流会被销毁，
 * `drain` 永远不会来（那会让这一轮的落库永远不执行）。
 * 📌 **销毁 / 关闭 / 出错都当「写完了」** —— 外层的 `finally` 负责落库。
 * 📌 **断开时立刻放行** —— 客户端已经走了，继续等没有意义，
 * 而且**会把落库卡住**（这一轮的回答就永远写不进库了）。
 */
async function writeChunk(
  stream: PassThrough,
  payload: string,
  signal?: AbortSignal,
): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return;
  let flushed: boolean;
  try {
    flushed = stream.write(payload);
  } catch {
    return;
  }
  if (flushed) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => done();
    stream.once('drain', done);
    stream.once('close', done);
    stream.once('error', done);
    // 📌 **断开就别等了** —— 否则 `finally` 里的落库永远跑不到
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) done();
  });
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

  // ⚠️ **assistant 消息 id 先定下来** —— 图状态、工具流水、落库、
  //    「重启后恢复」用的都是**这一个 id**（三处各生成一个会写成三条消息）
  const assistantMessageId = nanoid();

  // 📌 **会话全链路日志：开一轮 + 记「收到请求」**
  //    （见 [12-e E7](../docs/12-e-需求-观测安全与验收.md)）
  //    ⚠️ **没有会话就没有日志** —— 日志挂在会话上（跟消息、工具流水一样）
  if (sessionId) {
    await startTurn({
      turnId: assistantMessageId,
      sessionId,
      ...(model ? { model: model.name } : {}),
    });
    logEvent({
      turnId: assistantMessageId,
      sessionId,
      type: 'request.received',
      eventKey: 'request.received',
      title: '收到请求',
      payload: {
        trigger: parsed.data.trigger ?? null,
        userText,
        messages: parsed.data.messages,
      },
    });
  }

  // ── 斜杠命令：**服务端解析，零 LLM 调用** ──
  // ⚠️ **命令不要求配模型** —— `/help` 用不着模型，
  //    「没配模型就什么都干不了」对命令不成立
  if (command) {
    const result = await runCommand(command, { sessionId });

    if (sessionId) {
      logEvent({
        turnId: assistantMessageId,
        sessionId,
        type: 'command.executed',
        eventKey: 'command.executed',
        title: `斜杠命令 /${command.name}`,
        payload: { command: command.name, args: command.args, result: result.text },
      });
      logEvent({
        turnId: assistantMessageId,
        sessionId,
        type: 'turn.finished',
        eventKey: 'turn.finished',
        title: '收尾',
        payload: { text: result.text, kind: 'command' },
      });
    }

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

  // ⚠️ **assistant 消息 id 先定下来** —— 见上面（**同一个 id**）
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
    after: (text) => {
      // 📌 **记忆抽取：fire-and-forget**（不阻塞这一轮）
      //    📌 **带上会话 id** —— 这一轮若已用 `memory` 工具手动改过记忆，
      //    自动抽取会跳过（否则同一条记忆被写两遍）
      void runMemoryExtraction({
        userText,
        assistantText: text,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionId ? { turnId: assistantMessageId } : {}),
      }).catch((err) => {
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
  const { sessionId, approved, fingerprint, approveAll } = parsed.data;

  const session = await findSession(sessionId);
  if (!session) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }

  // 📌 **把指纹带回去** —— 后端核对「批准的是不是这一组参数」
  // 📌 **approveAll 也带回去** —— 「本轮剩下的都批准」
  const decision = {
    approved,
    ...(fingerprint ? { fingerprint } : {}),
    ...(approveAll ? { approveAll } : {}),
  };

  // ── 路 1：有人在等 ──
  if (resolvePendingDecision(sessionId, decision)) {
    ctx.body = { ok: true, mode: 'resumed' };
    return;
  }

  // ── 路 2：后端重启过 —— 自己恢复图 ──
  const parts = createPartsAccumulator();
  try {
    const events = streamChatTurn({
      sessionId,
      messageId: nanoid(),
      resume: decision,
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
