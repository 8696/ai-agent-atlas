import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import Router from '@koa/router';
import { z } from 'zod';
import { createChatEventStream, describeError } from '../agent/events';
import { AppError } from '../lib/errors';
import { logger } from '../logger';
import { streamChatReply } from '../services/chat';
import { resolveFallback, resolveModel } from '../services/model';

/**
 * 对话网关 —— `/api/v1/chat`（SSE）+ `/api/v1/models`。
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
  /** 用户勾了「思考模式」（见 [12-b B8](../docs/12-b-需求-对话与编排.md)） */
  thinking: z.boolean().optional(),
});

export const chatRouter = new Router({ prefix: '/api/v1' });

/**
 * `POST /api/v1/chat` —— 一轮对话，流式返回。
 *
 * ⚠️ **没配模型 → 503**（不是 500）：这是**运行时状态**，用户要做的是改 `.env` 的
 * `LLM_MODEL`（见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）。
 */
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

  const abort = new AbortController();

  const events = streamChatReply({
    messages: parsed.data.messages,
    model,
    thinking: parsed.data.thinking ?? false,
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

  void (async () => {
    try {
      for await (const chunk of createChatEventStream({ events })) {
        if (!stream.write(`data: ${JSON.stringify(chunk)}\n\n`)) {
          await once(stream, 'drain');
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
    }
  })();
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
