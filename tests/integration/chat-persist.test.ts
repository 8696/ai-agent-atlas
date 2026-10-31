import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { useTempDatabase } from '../fixtures/db';

/**
 * 对话落库的集成测试 —— **真 SSE · 真 SQLite · 假模型**。
 *
 * ⚠️ **模型必须 mock** —— 打一次真模型十几秒，用例不能这么慢。
 */

// ⚠️ **静音日志** —— pino 直接写 stdout，会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock('../../src/services/model', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/model')>(
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
    createChatModel: () => {
      // ⚠️ **`bindTools` 要有** —— 图的 plan 节点会绑工具再调模型
      const model = {
        bindTools: () => model,
        stream: async function* () {
          for (const piece of ['你', '好']) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield { text: piece };
          }
        },
      };
      return model;
    },
  };
});

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
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

interface StoredMessage {
  id: string;
  role: string;
  content: string;
  parts: Array<{ type: string; text?: string; state?: string }>;
  favorite: boolean;
}

async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function readMessages(sessionId: string): Promise<StoredMessage[]> {
  const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`);
  const body = (await response.json()) as { messages: StoredMessage[] };
  return body.messages;
}

/** 轮询等落库（**落库在流结束之后**，不是响应结束的那一刻） */
async function waitForMessages(
  sessionId: string,
  expected: number,
  timeoutMs = 3000,
): Promise<StoredMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let messages: StoredMessage[] = [];
  while (Date.now() < deadline) {
    messages = await readMessages(sessionId);
    if (messages.length >= expected) return messages;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return messages;
}

describe('对话落库（[12-b B2](../docs/12-b-需求-对话与编排.md)）', () => {
  it('⚠️ 落库的 parts 与推给前端的是同一份', async () => {
    const sessionId = await createSession();

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      }),
    });
    expect(response.status).toBe(200);

    const chunks = parseSse(await response.text());
    const streamed = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(streamed).toBe('你好');

    const messages = await waitForMessages(sessionId, 2);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('你好');
    expect(messages[1]?.role).toBe('assistant');
    // ⚠️ **逐字一致** —— 落库的正文与流出来的一致
    expect(messages[1]?.content).toBe(streamed);
    expect(messages[1]?.parts[0]?.text).toBe(streamed);
  });

  it('⚠️ 首条用户消息生成标题（≤ 30 字）', async () => {
    const sessionId = await createSession();
    await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '帮我看看这个仓库' }] }],
      }),
    });
    await waitForMessages(sessionId, 2);

    const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`);
    const body = (await response.json()) as { session: { title: string; messageCount: number } };
    expect(body.session.title).toBe('帮我看看这个仓库');
    expect(body.session.messageCount).toBe(2);
  });

  it('⚠️ assistant 消息 id 由服务端给（前端收藏点得中）', async () => {
    const sessionId = await createSession();
    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      }),
    });
    const chunks = parseSse(await response.text());
    const start = chunks.find((chunk) => chunk.type === 'start');
    expect(typeof start?.['messageId']).toBe('string');

    const messages = await waitForMessages(sessionId, 2);
    expect(messages[1]?.id).toBe(start?.['messageId']);
  });

  it('⚠️ 重新生成 = 删掉旧的那条，不是多一条', async () => {
    const sessionId = await createSession();
    const userMessage = { role: 'user', parts: [{ type: 'text', text: '你好' }] };

    await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, messages: [userMessage] }),
    });
    await waitForMessages(sessionId, 2);

    // ⚠️ **前端「重新生成」时会把那条 assistant 砍掉再重发** —— 库里也要跟着少一条
    await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        trigger: 'regenerate-message',
        messages: [userMessage],
      }),
    });
    const messages = await waitForMessages(sessionId, 2);
    expect(messages).toHaveLength(2);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('⚠️ 客户端消息 id 撞了 → 不炸（改成更新那一行）', async () => {
    const sessionId = await createSession();
    const fixedId = 'client-fixed-id';

    // 第一次：正常落库
    const first = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ id: fixedId, role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      }),
    });
    expect(first.status).toBe(200);
    await waitForMessages(sessionId, 2);

    // ⚠️ **同一个 id 再来一次** —— 主键冲突会让 `create` 抛错，整个请求 500
    const second = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ id: fixedId, role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      }),
    });
    expect(second.status).toBe(200);

    const messages = await waitForMessages(sessionId, 2);
    expect(messages.filter((message) => message.id === fixedId)).toHaveLength(1);
  });

  it('会话不存在 → 404（不静默新建）', async () => {
    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'does-not-exist',
        messages: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      }),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'SESSION_NOT_FOUND',
    );
  });
});
