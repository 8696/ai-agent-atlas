import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { QueryTypes } from 'sequelize';
import { useTempDatabase } from '../fixtures/db';

/**
 * **图检查点的裁剪与孤儿回收**的集成测试（见 [12-b B6](../docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **为什么要测这个** ——
 * 每个图节点落一个检查点，而**每个检查点都存全量图状态**
 * → 行数随步数线性涨、每行体积随对话变长 → **平方级**。
 * 没有这道闸，库会被检查点吃光。
 */

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

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
      const model = {
        bindTools: () => model,
        stream: async function* (_messages: Array<{ getType(): string; content: string }>) {
          yield { text: '好的' };
        },
      };
      return model;
    },
  };
});

useTempDatabase();

const { initDatabase, sequelize } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');
const { collectOrphanThreads, pruneAllThreads } = await import('../../src/agent/checkpointer');

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

/** 发一轮并读完流 */
async function chat(sessionId: string, text: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/** 某个 thread 的检查点行数（**含 metadata 行** —— 每个检查点占两行） */
async function checkpointRows(threadId: string): Promise<number> {
  const rows = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM graph_checkpoints WHERE thread_id = :threadId`,
    { type: QueryTypes.SELECT, replacements: { threadId } },
  );
  return Number(rows[0]?.n ?? 0);
}

describe('图检查点的裁剪', () => {
  it('📌 连聊很多轮 → 检查点**不超过 8 个**（不平方级涨）', async () => {
    const sessionId = await createSession();

    // 📌 **连聊 12 轮** —— 每轮至少落 prepare / plan / answer 三个检查点
    for (let i = 0; i < 12; i += 1) {
      await chat(sessionId, `第 ${i} 轮`);
    }

    const rows = await checkpointRows(sessionId);
    // 📌 **每个检查点两行**（`checkpoint` + `metadata`）→ 8 个检查点 = 16 行
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(16);
  });

  it('📌 裁剪**不动**还没跑完的那一轮（最新检查点留着）', async () => {
    const sessionId = await createSession();
    await chat(sessionId, '一轮');

    // 📌 **最新的那个检查点必须在** —— 恢复靠它
    const rows = await sequelize.query<{ checkpoint_id: string }>(
      `SELECT checkpoint_id FROM graph_checkpoints
        WHERE thread_id = :threadId AND type = 'checkpoint'
        ORDER BY checkpoint_id DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { threadId: sessionId } },
    );
    expect(rows.length).toBe(1);
  });
});

describe('孤儿 thread 的回收', () => {
  it('📌 会话已不存在的 thread → 检查点被回收', async () => {
    // 📌 **造一个孤儿** —— 一个既不是会话 id、也不是 `subagent:` 的 thread
    const orphan = 'orphan-thread-for-test';
    await sequelize.query(
      `INSERT INTO graph_checkpoints
         (id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, serde_type, data, created_at)
       VALUES
         (:id1, :threadId, '', :cid, NULL, 'checkpoint', 'json', '{}', :now),
         (:id2, :threadId, '', :cid, NULL, 'metadata',   'json', '{}', :now)`,
      {
        replacements: {
          id1: `${orphan}|c1|checkpoint`,
          id2: `${orphan}|c1|metadata`,
          threadId: orphan,
          cid: 'c1',
          now: '2026-11-01 00:00:00.000',
        },
      },
    );
    expect(await checkpointRows(orphan)).toBe(2);

    const collected = await collectOrphanThreads();
    expect(collected).toBeGreaterThanOrEqual(1);
    expect(await checkpointRows(orphan)).toBe(0);
  });

  it('📌 **子代理的 thread 不回收**（父图挂起时还要靠它恢复）', async () => {
    const subagentThread = 'subagent:0123456789abcdef';
    await sequelize.query(
      `INSERT INTO graph_checkpoints
         (id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, serde_type, data, created_at)
       VALUES
         (:id1, :threadId, '', :cid, NULL, 'checkpoint', 'json', '{}', :now),
         (:id2, :threadId, '', :cid, NULL, 'metadata',   'json', '{}', :now)`,
      {
        replacements: {
          id1: `${subagentThread}|c1|checkpoint`,
          id2: `${subagentThread}|c1|metadata`,
          threadId: subagentThread,
          cid: 'c1',
          now: '2026-11-01 00:00:00.000',
        },
      },
    );

    await collectOrphanThreads();

    // 📌 **还在** —— 子代理的 thread 不能当孤儿收掉
    expect(await checkpointRows(subagentThread)).toBe(2);
  });

  it('📌 **活着的会话不受影响**', async () => {
    const sessionId = await createSession();
    await chat(sessionId, '一轮');
    const before = await checkpointRows(sessionId);

    await collectOrphanThreads();
    await pruneAllThreads();

    expect(await checkpointRows(sessionId)).toBe(before);
  });
});
