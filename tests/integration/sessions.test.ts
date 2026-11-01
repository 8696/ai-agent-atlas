import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { useTempDatabase } from '../fixtures/db';

/**
 * 会话管理的集成测试 —— **真 Koa · 真 SQLite（临时库）**。
 *
 * ⚠️ **每个文件一个独立库**（见 `tests/fixtures/db.ts`）——
 * 隔离做好之后并行跑测试才是白捡的性能。
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
const { Message } = await import('../../src/models/message.model.js');

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

async function createSession(): Promise<{ id: string; title: string; favorite: boolean }> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; title: string; favorite: boolean };
}

interface ListBody {
  items: Array<{ id: string; title: string; favorite: boolean; messageCount: number }>;
  total: number;
  page: number;
  pageSize: number;
}

async function listSessions(params = ''): Promise<ListBody> {
  const response = await fetch(`${baseUrl}/api/v1/sessions${params}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ListBody;
}

describe('会话管理（[12-b B2](../docs/12-b-需求-对话与编排.md)）', () => {
  it('新建会话 → 列表里能看到', async () => {
    const created = await createSession();
    expect(created.id).toBeTruthy();
    expect(created.favorite).toBe(false);

    const list = await listSessions();
    expect(list.items.some((item) => item.id === created.id)).toBe(true);
    expect(list.total).toBeGreaterThan(0);
  });

  it('改名', async () => {
    const created = await createSession();
    const response = await fetch(`${baseUrl}/api/v1/sessions/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新的标题' }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { title: string }).title).toBe('新的标题');

    const detail = await fetch(`${baseUrl}/api/v1/sessions/${created.id}`);
    expect(((await detail.json()) as { session: { title: string } }).session.title).toBe(
      '新的标题',
    );
  });

  it('⚠️ 收藏：不传 body = 切换', async () => {
    const created = await createSession();

    const first = await fetch(`${baseUrl}/api/v1/sessions/${created.id}/favorite`, {
      method: 'PATCH',
    });
    expect(((await first.json()) as { favorite: boolean }).favorite).toBe(true);

    const second = await fetch(`${baseUrl}/api/v1/sessions/${created.id}/favorite`, {
      method: 'PATCH',
    });
    expect(((await second.json()) as { favorite: boolean }).favorite).toBe(false);
  });

  it('标题关键词搜索（服务端筛）', async () => {
    const created = await createSession();
    await fetch(`${baseUrl}/api/v1/sessions/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '独特的关键词' }),
    });

    const hit = await listSessions('?q=独特');
    expect(hit.items.some((item) => item.id === created.id)).toBe(true);

    const miss = await listSessions('?q=不可能存在的词');
    expect(miss.items.some((item) => item.id === created.id)).toBe(false);
    expect(miss.total).toBe(0);
  });

  it('只看收藏（服务端筛）', async () => {
    const starred = await createSession();
    await fetch(`${baseUrl}/api/v1/sessions/${starred.id}/favorite`, { method: 'PATCH' });
    const plain = await createSession();

    const list = await listSessions('?favorite=1');
    expect(list.items.some((item) => item.id === starred.id)).toBe(true);
    expect(list.items.some((item) => item.id === plain.id)).toBe(false);
    // ⚠️ **总数是筛选后的数量**（不是全库总数）
    expect(list.total).toBe(list.items.length);
  });

  it('⚠️ 删会话 → 消息一并清掉，不留孤儿行', async () => {
    const created = await createSession();
    await Message.create({
      id: 'orphan-check',
      session_id: created.id,
      role: 'user',
      content: '你好',
      favorite: 0,
      created_at: '2026-10-31 10:00:00.000',
      updated_at: '2026-10-31 10:00:00.000',
    });

    const before = await Message.count({ where: { session_id: created.id } });
    expect(before).toBe(1);

    const response = await fetch(`${baseUrl}/api/v1/sessions/${created.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    const after = await Message.count({ where: { session_id: created.id } });
    expect(after).toBe(0);

    const detail = await fetch(`${baseUrl}/api/v1/sessions/${created.id}`);
    expect(detail.status).toBe(404);
  });

  it('会话不存在 → 404（不静默新建）', async () => {
    const response = await fetch(`${baseUrl}/api/v1/sessions/does-not-exist`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'SESSION_NOT_FOUND',
    );
  });

  it('消息级收藏（不传 body = 切换）', async () => {
    const created = await createSession();
    await Message.create({
      id: 'fav-message',
      session_id: created.id,
      role: 'assistant',
      content: '回答',
      favorite: 0,
      created_at: '2026-10-31 10:00:00.000',
      updated_at: '2026-10-31 10:00:00.000',
    });

    const first = await fetch(`${baseUrl}/api/v1/messages/fav-message/favorite`, {
      method: 'PATCH',
    });
    expect(((await first.json()) as { favorite: boolean }).favorite).toBe(true);

    // ⚠️ **只看收藏要能筛出「有收藏消息」的会话**（见 [04-b §4.2](../docs/04-b-ui-聊天页.md)）
    const list = await listSessions('?favorite=1');
    expect(list.items.some((item) => item.id === created.id)).toBe(true);
  });
});

describe('会话导出（[12-b B2](../docs/12-b-需求-对话与编排.md)）', () => {
  it('GET /sessions/:id/export → Markdown（含对话正文）', async () => {
    const created = await createSession();
    await Message.create({
      id: 'export-message',
      session_id: created.id,
      role: 'user',
      content: '导出测试',
      favorite: 0,
      created_at: '2026-10-31 10:00:00.000',
      updated_at: '2026-10-31 10:00:00.000',
    });

    const response = await fetch(`${baseUrl}/api/v1/sessions/${created.id}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toContain('attachment');

    const text = await response.text();
    expect(text).toContain('# ');
    expect(text).toContain('导出测试');
    expect(text).toContain('会话 id');
  });

  it('?format=json → 完整消息与 parts', async () => {
    const created = await createSession();
    await Message.create({
      id: 'export-json-message',
      session_id: created.id,
      role: 'assistant',
      content: '回答',
      parts: JSON.stringify([{ type: 'text', text: '回答' }]),
      favorite: 0,
      created_at: '2026-10-31 10:00:00.000',
      updated_at: '2026-10-31 10:00:00.000',
    });

    const response = await fetch(`${baseUrl}/api/v1/sessions/${created.id}/export?format=json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { id: string };
      messages: Array<{ content: string; parts: Array<{ type: string }> }>;
    };
    expect(body.session.id).toBe(created.id);
    expect(body.messages.some((message) => message.content === '回答')).toBe(true);
  });

  it('⚠️ 会话不存在 → 404', async () => {
    const response = await fetch(`${baseUrl}/api/v1/sessions/does-not-exist/export`);
    expect(response.status).toBe(404);
  });
});
