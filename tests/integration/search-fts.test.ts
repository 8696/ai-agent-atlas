import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTempDatabase } from '../fixtures/db';

/**
 * 跨会话检索的集成测试 —— **真 SQLite · 真 FTS5**。
 *
 * 覆盖（[12-d D3](../docs/12-d-需求-记忆与配置.md)）：
 * - FTS5 + trigram 可用性探测
 * - ⚠️ **中文短句能被搜到**（trigram 生效）
 * - 记忆条目也能被搜到
 * - 查询词太短 → 不炸（trigram 要求 ≥ 3 字符）
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { probeFts, ensureFtsTables, toMatchQuery } = await import('../../src/lib/fts');
const { searchAll } = await import('../../src/services/search');
const { addMemory, clearMemory } = await import('../../src/services/memory/index');
const { Message } = await import('../../src/models/message.model');
const { Session } = await import('../../src/models/session.model');
const { utcNow } = await import('../../src/lib/time');

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
  await ensureFtsTables();
});

describe('FTS5 能力探测', () => {
  it('FTS5 可用（**探测要真的建一张虚表**）', async () => {
    const probe = await probeFts();
    expect(probe.available).toBe(true);
  });

  it('查询词要包成短语（**否则 FTS5 语法报错**）', () => {
    expect(toMatchQuery('数据库')).toBe('"数据库"');
    // ⚠️ **引号要转义** —— 否则用户输入一个引号就把查询语法搞坏了
    expect(toMatchQuery('a"b')).toBe('"a""b"');
    // ⚠️ **trigram 要求 ≥ 3 字符** —— 太短直接不查
    expect(toMatchQuery('数据')).toBeNull();
    expect(toMatchQuery('ab')).toBeNull();
  });
});

describe('跨会话检索', () => {
  it('⚠️ 中文短句能被搜到（trigram 生效）', async () => {
    const session = await Session.create({
      id: 'fts-session-1',
      title: '测试会话',
      status: 'active',
      favorite: 0,
      summary: null,
      metadata: null,
      thread_id: 'fts-session-1',
      message_count: 0,
      last_active_at: utcNow(),
      created_at: utcNow(),
      updated_at: utcNow(),
    });
    await Message.create({
      id: 'fts-message-1',
      session_id: 'fts-session-1',
      role: 'user',
      content: '我今天跑了一下单元测试，全绿',
      parts: null,
      tool_calls: null,
      tool_results: null,
      attachments: null,
      favorite: 0,
      metadata: null,
      created_at: utcNow(),
      updated_at: utcNow(),
    });

    const result = await searchAll('单元测试');
    expect(result.degraded).toBe(false);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.snippet).toContain('单元测试');
    expect(session.id).toBe('fts-session-1');
  });

  it('记忆条目也能被搜到', async () => {
    clearMemory('USER');
    addMemory({ file: 'USER', name: 'db-port', body: '数据库在 5432 端口' });

    const result = await searchAll('5432');
    expect(result.hits.some((hit) => hit.kind === 'memory')).toBe(true);
  });

  it('空查询 → 不检索', async () => {
    const result = await searchAll('   ');
    expect(result.hits).toHaveLength(0);
  });
});
