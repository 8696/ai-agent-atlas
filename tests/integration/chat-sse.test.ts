import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

/**
 * `POST /api/v1/chat` 的**集成测试** —— 真 Koa · 真 SSE · **假模型**。
 *
 * ⚠️ **模型必须 mock** —— 打一次真模型十几秒，用例不能这么慢。
 * 协议、提示词注入、断线中止这些**用假模型就能验**，而且是**秒级**。
 * 真模型的冒烟测试留到「交付这条需求」时手测一次就够。
 */

interface StreamCall {
  messages: Array<{ getType(): string; content: string }>;
  signal?: AbortSignal;
}

const calls: StreamCall[] = [];
/** 假模型被 abort 时置位 —— 用来验「客户端断开 → 上游真的停」 */
let aborted = false;
/** 假模型每段之间的间隔（断线测试要调慢，才有机会在流中间断开） */
let pieceDelayMs = 5;

// ⚠️ **只 mock 模型解析** —— 其余（AppError / 提示词 / 协议层）都走真代码
vi.mock('../../src/logger', () => ({
  // pino 直接写 stdout，会把 agent reporter 的输出冲掉 —— 测试里静音
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock('../../src/services/model', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/services/model')>(
      '../../src/services/model',
    );
  return {
    ...actual,
    resolveModel: () => ({
      name: 'fake-model',
      baseUrl: 'http://fake.local',
      apiKey: 'fake-key',
      modelId: 'fake-model',
      maxTokens: 1024,
      temperature: 1,
      thinkingBudget: 0,
    }),
    resolveFallback: () => undefined,
    createChatModel: () => ({
      stream: async function* (messages: StreamCall['messages'], options?: { signal?: AbortSignal }) {
        calls.push({ messages, ...(options?.signal ? { signal: options.signal } : {}) });
        for (const piece of ['你', '好']) {
          await new Promise((resolve) => setTimeout(resolve, pieceDelayMs));
          if (options?.signal?.aborted) {
            aborted = true;
            return;
          }
          yield { text: piece };
        }
      },
    }),
  };
});

const { createApp } = await import('../../src/app');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

/** SSE 文本 → chunk 数组 */
function parseSse(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as { type: string; [key: string]: unknown });
}

function postChat(body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

const userMessage = { role: 'user', parts: [{ type: 'text', text: '你好' }] };

describe('POST /api/v1/chat', () => {
  it('按协议顺序吐 chunk（text-delta 拼起来就是回复）', async () => {
    const response = await postChat({ messages: [userMessage] });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const chunks = parseSse(await response.text());
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('你好');
  });

  it('⚠️ system 提示词在最前（人格压过历史消息）', async () => {
    await postChat({ messages: [userMessage] });
    const call = calls.at(-1);
    expect(call?.messages[0]?.getType()).toBe('system');
    expect(call?.messages[0]?.content).toContain('Atlas');
    expect(call?.messages[1]?.getType()).toBe('human');
    expect(call?.messages[1]?.content).toBe('你好');
  });

  it('客户端断开 → 上游调用真的被中止', async () => {
    aborted = false;
    // ⚠️ **把假模型调慢** —— 否则它早就流完了，断开根本碰不到中途
    pieceDelayMs = 300;
    try {
      const controller = new AbortController();
      const pending = postChat({ messages: [userMessage] }, controller.signal);
      // 等模型真的开始流了再断
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await pending.catch(() => undefined);

      const deadline = Date.now() + 2000;
      while (!aborted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(aborted).toBe(true);
    } finally {
      pieceDelayMs = 5;
    }
  });

  it('请求体不对 → 400 + 统一错误体', async () => {
    const response = await postChat({ messages: [{ role: 'unknown-role', parts: [] }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: '请求体格式不对' },
    });
  });
});

describe('GET /api/v1/models', () => {
  it('只回模型名，不回 API Key', async () => {
    const response = await fetch(`${baseUrl}/api/v1/models`);
    const body = (await response.json()) as {
      configured: boolean;
      models: Array<{ name: string; role: string }>;
    };
    expect(body.configured).toBe(true);
    expect(body.models[0]?.name).toBe('fake-model');
    expect(JSON.stringify(body)).not.toContain('fake-key');
  });
});
