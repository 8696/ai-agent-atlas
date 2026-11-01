import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { useTempDatabase } from '../fixtures/db';
// 📌 **类型导入是擦除的** —— 不会在运行时加载模块，不影响「先切数据目录」的顺序
import type { UsageScope } from '../../src/models/cost-log.model.js';

/**
 * 用量统计的集成测试 —— **真 Koa · 真 SQLite（临时库）**。
 *
 * 覆盖（[12-d D7](../docs/12-d-需求-记忆与配置.md)）：
 * - `GET /api/v1/stats/usage` → 合计 · 本月 · 按会话 · 按模型 · 按用途
 * - **会话列表带 token 数**（`SessionView.totalTokens`）
 * - ⚠️ **没有会话归属的用量单列**（记忆抽取 / 检索摘要）
 */

// ⚠️ **静音日志** —— pino 直接写 stdout，会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');
const { CostLog } = await import('../../src/models/cost-log.model.js');
const { utcNow } = await import('../../src/lib/time.js');

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

async function createSession(title: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  await fetch(`${baseUrl}/api/v1/sessions/${body.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return body.id;
}

/** 写一条用量（**绕过记账流程** —— 这里只关心聚合口径） */
async function writeUsage(row: {
  sessionId?: string | null;
  scope?: UsageScope;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  await CostLog.create({
    id: `log-${Math.random().toString(36).slice(2)}`,
    session_id: row.sessionId ?? null,
    message_id: null,
    provider: 'anthropic',
    model: row.model ?? 'fake-model',
    usage_scope: row.scope ?? 'chat',
    prompt_tokens: row.inputTokens,
    completion_tokens: row.outputTokens,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cost: 0,
    created_at: utcNow(),
  });
}

interface StatsBody {
  total: { totalTokens: number; inputTokens: number; outputTokens: number; entries: number };
  month: { totalTokens: number };
  sessionCount: number;
  unattributedTokens: number;
  sessions: Array<{
    id: string;
    title: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    entries: number;
  }>;
  models: Array<{ model: string; totalTokens: number }>;
  scopes: Array<{ scope: string; totalTokens: number }>;
}

async function fetchStats(): Promise<StatsBody> {
  const response = await fetch(`${baseUrl}/api/v1/stats/usage`);
  expect(response.status).toBe(200);
  return (await response.json()) as StatsBody;
}

describe('用量统计', () => {
  it('按会话 / 按模型 / 按用途拆开 + 合计', async () => {
    const a = await createSession('会话 A');
    const b = await createSession('会话 B');

    await writeUsage({ sessionId: a, inputTokens: 100, outputTokens: 20 });
    await writeUsage({ sessionId: a, scope: 'summary', inputTokens: 30, outputTokens: 10 });
    await writeUsage({ sessionId: b, model: 'other-model', inputTokens: 5, outputTokens: 1 });
    // ⚠️ **没有会话归属的用量** —— 记忆抽取是全局副作用
    await writeUsage({ sessionId: null, scope: 'memory', inputTokens: 50, outputTokens: 25 });

    const stats = await fetchStats();

    // 📌 **合计** = A(120+40) + B(6) + 无归属(75) = 241
    expect(stats.total.totalTokens).toBe(241);
    expect(stats.total.inputTokens).toBe(185);
    expect(stats.total.outputTokens).toBe(56);
    expect(stats.month.totalTokens).toBe(241);

    // 📌 **会话合计** = A(160) + B(6)；**没有用量的会话也在列表里**
    expect(stats.sessionCount).toBe(2);
    const rowA = stats.sessions.find((row) => row.id === a);
    expect(rowA?.title).toBe('会话 A');
    expect(rowA?.totalTokens).toBe(160);
    expect(rowA?.inputTokens).toBe(130);
    expect(rowA?.outputTokens).toBe(30);
    expect(rowA?.entries).toBe(2);

    // ⚠️ **差额单列** —— 75 是「没有会话归属」的那部分
    expect(stats.unattributedTokens).toBe(75);

    // 📌 **按模型 / 按用途**
    expect(stats.models.find((row) => row.model === 'other-model')?.totalTokens).toBe(6);
    expect(stats.scopes.find((row) => row.scope === 'memory')?.totalTokens).toBe(75);
    expect(stats.scopes.find((row) => row.scope === 'summary')?.totalTokens).toBe(40);
  });

  it('会话列表带 totalTokens', async () => {
    const id = await createSession('带 token 的会话');
    await writeUsage({ sessionId: id, inputTokens: 7, outputTokens: 3 });

    const response = await fetch(`${baseUrl}/api/v1/sessions?pageSize=100`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ id: string; totalTokens: number }>;
    };
    const item = body.items.find((row) => row.id === id);
    expect(item?.totalTokens).toBe(10);
  });

  it('改名 / 收藏不会把 token 数抹成 0', async () => {
    const id = await createSession('改名测试');
    await writeUsage({ sessionId: id, inputTokens: 11, outputTokens: 4 });

    const patched = await fetch(`${baseUrl}/api/v1/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改名之后' }),
    });
    const body = (await patched.json()) as { title: string; totalTokens: number };
    expect(body.title).toBe('改名之后');
    expect(body.totalTokens).toBe(15);
  });
});
