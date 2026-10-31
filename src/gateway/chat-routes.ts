import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import Router from '@koa/router';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { createChatEventStream, createPartsAccumulator, describeError } from '../agent/events.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../logger.js';
import { streamChatTurn, getPendingTurnMessageId } from '../services/chat.js';
import { resolveModel, resolveFallback } from '../services/model.js';
import {
  appendAssistantMessage,
  applyTitleFromFirstUserMessage,
  syncMessages,
} from '../services/message.js';
import { resolvePendingDecision } from '../services/pending-confirm.js';
import { findSession, touchSession } from '../services/session.js';

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
  if (!model) {
    throw new AppError(
      'MODEL_NOT_CONFIGURED',
      '还没配置模型，去改 .env 的 LLM_MODEL（改完重启后端）',
      503,
    );
  }

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

  const abort = new AbortController();

  // ⚠️ **assistant 消息 id 先定下来** —— 图状态、工具流水、落库、
  //    「重启后恢复」用的都是**这一个 id**（三处各生成一个会写成三条消息）
  const assistantMessageId = nanoid();

  const events = streamChatTurn({
    messages: parsed.data.messages,
    ...(sessionId ? { sessionId } : {}),
    messageId: assistantMessageId,
    signal: abort.signal,
  });

  const stream = new PassThrough();
  // 客户端断开时写流会 EPIPE —— 吞掉，别让未捕获异常把进程带走
  stream.on('error', () => {});

  // ⚠️ **客户端断开不算错误**（见 [12-b B1](../docs/12-b-需求-对话与编排.md)）：
  //    响应流提前关闭会让 Node 抛 ERR_STREAM_PREMATURE_CLOSE —— 那不是服务故障
  ctx.res.on('error', (err: NodeJS.ErrnoException) => {
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

  // ⚠️ **落库的 parts 与推给前端的同源** —— 同一个累加器吃同一批 chunk
  const parts = createPartsAccumulator();

  void (async () => {
    try {
      for await (const chunk of createChatEventStream({ events, messageId: assistantMessageId })) {
        parts.add(chunk);
        if (!stream.write(`data: ${JSON.stringify(chunk)}\n\n`)) {
          await once(stream, 'drain');
        }
        // ⚠️ **挂起时先把部分内容落库** ——
        //    「重启后待确认的卡片还在」靠的就是这一笔
        //    （见 [12-b B5](../docs/12-b-需求-对话与编排.md)）
        if (chunk.type === 'data-pending-confirm' && sessionId) {
          try {
            await appendAssistantMessage(sessionId, {
              id: assistantMessageId,
              content: parts.text(),
              parts: parts.parts(),
              metadata: { model: model.name, pendingConfirm: true },
            });
          } catch (err) {
            logger.error({ err, sessionId }, '挂起时落库失败');
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
      if (sessionId) {
        try {
          await appendAssistantMessage(sessionId, {
            id: assistantMessageId,
            content: parts.text(),
            parts: parts.parts(),
            metadata: { model: model.name },
          });
        } catch (err) {
          // ⚠️ **落库失败不许打断对话** —— 用户已经看到回答了
          logger.error({ err, sessionId }, 'failed to persist assistant message');
        }
        try {
          await touchSession(sessionId);
        } catch (err) {
          logger.error({ err, sessionId }, 'failed to refresh session counters');
        }
      }
    }
  })();
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
