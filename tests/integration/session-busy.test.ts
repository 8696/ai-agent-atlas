import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { useTempDatabase } from '../fixtures/db';

/**
 * **同一会话的并发闸**的集成测试（真 Koa · 真 SSE · 假模型）。
 *
 * 📌 **为什么要这道闸** ——
 * 同一会话同时跑两轮会互相踩：
 * `prepare` 节点的「清空再写」会把对方刚装配好的上下文一起清掉，
 * 检查点也会互相覆盖（同一个 `thread_id`）。
 * 前端只挡了「同一个标签页连点」，**两个标签页挡不住**。
 *
 * 📌 **闸要放得快** ——
 * 这一轮跑完就释放，**不能等落库完** ——
 * 客户端读完流就会立刻发下一条，
 * 等落库完再释放的话，用户的下一条会被自己的上一条挡住。
 */

vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 假模型每一段之间的间隔（**调慢才有机会在流中间再发一条**） */
const pieceDelayMs = 300;

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
      const model = {
        bindTools: () => model,
        stream: async function* (_messages: Array<{ getType(): string; content: string }>) {
          for (const piece of ['你', '好']) {
            await new Promise((resolve) => setTimeout(resolve, pieceDelayMs));
            yield { text: piece };
          }
        },
      };
      return model;
    },
  };
});

useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');

await initDatabase();
await umzug.up();

let server: Server;
let baseUrl = '';

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

/** 建一个会话 */
async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** 发一轮（**不读完流** —— 只看状态码） */
async function postChat(
  sessionId: string,
  text: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
  const body = await response.text();
  return { status: response.status, body };
}

describe('同一会话的并发闸', () => {
  it('📌 上一轮没跑完时，同一会话再发 → 409（不是互相踩）', async () => {
    const sessionId = await createSession();

    // 📌 **先发一条，不等它跑完**
    const first = postChat(sessionId, '第一条');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 📌 **同一会话再发一条** —— 上一轮还在跑
    const second = await postChat(sessionId, '第二条');
    expect(second.status).toBe(409);
    expect(second.body).toContain('SESSION_BUSY');

    // 📌 **等第一条跑完**
    await first;
  });

  it('📌 上一轮跑完之后，同一会话能接着发', async () => {
    const sessionId = await createSession();

    const first = await postChat(sessionId, '第一条');
    expect(first.status).toBe(200);

    // 📌 **闸要放得快** —— 客户端读完流就会立刻发下一条，
    //    等落库完才释放的话，这里会撞上 409
    const second = await postChat(sessionId, '第二条');
    expect(second.status).toBe(200);
  });

  it('📌 不同会话互不影响', async () => {
    const a = await createSession();
    const b = await createSession();

    const first = postChat(a, 'A 的第一轮');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 📌 **另一个会话照跑不误**
    const other = await postChat(b, 'B 的第一轮');
    expect(other.status).toBe(200);

    await first;
  });
});
