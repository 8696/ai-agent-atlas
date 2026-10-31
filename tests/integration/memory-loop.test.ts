import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` / `invoke` 是 **async** —— 签名要求它返回 Promise，
 * 它们只回固定内容、没有 await。
 */

/**
 * 记忆闭环的集成测试（见 [12-d D2 / D3](./12-d-需求-记忆与配置.md)）。
 *
 * 覆盖：
 * - 📌 **「记住我 prefers pnpm」→ 抽取 → 落进 `USER.md`**
 * - 📌 **几周前的对话内容能被 FTS5 搜到**（跨会话检索）
 */

/** 假模型抽取时返回的内容 */
let extractionReply = '';

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
        stream: async function* () {
          yield { text: '好的' };
        },
        invoke: async () => ({
          content: extractionReply,
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      };
      return model;
    },
  };
});

useTempDatabase();

const { initDatabase, sequelize } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { runMemoryExtraction } = await import('../../src/services/memory/extract');
const { readMemory } = await import('../../src/services/memory/store');
const { searchAll } = await import('../../src/services/search');
const { Message } = await import('../../src/models/message.model');
const { Session } = await import('../../src/models/session.model');
const { QueryTypes } = await import('sequelize');

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
});

beforeEach(() => {
  extractionReply = '';
});

describe('长期记忆的抽取闭环（[12-d D2](./12-d-需求-记忆与配置.md)）', () => {
  it('📌 「记住我 prefers pnpm」→ 抽取 → 落进 `USER.md`', async () => {
    extractionReply = JSON.stringify([
      { op: 'add', file: 'USER', name: 'prefers-pnpm', kind: 'preference', body: '用户 prefers pnpm' },
    ]);

    const result = await runMemoryExtraction({
      userText: '记住我 prefers pnpm',
      assistantText: '好，记下了。',
    });

    expect(result.applied).toBe(1);
    const user = readMemory('USER');
    const entry = user.entries.find((item) => item.name === 'prefers-pnpm');
    expect(entry).toBeDefined();
    expect(entry?.body).toContain('prefers pnpm');
  });

  it('📌 没抽取到东西 → 不落盘', async () => {
    extractionReply = '这一轮没什么值得记的。';
    const result = await runMemoryExtraction({
      userText: '记住我 prefers pnpm',
      assistantText: '好。',
    });
    expect(result.applied).toBe(0);
  });
});

describe('跨会话检索（[12-d D3](./12-d-需求-记忆与配置.md)）', () => {
  it('📌 几周前的对话内容能被搜到', async () => {
    // 📌 **先建 FTS 虚表与触发器** —— 否则这条消息进不了索引
    //    （触发器是「后建的」，先插入的消息不会被索引）
    const { ensureFtsTables } = await import('../../src/lib/fts');
    await ensureFtsTables();

    // ⚠️ **造一条「三周前」的对话** —— 检索不能只看最近的
    const old = await Session.create({
      id: 'old-session-1',
      title: '三周前的数据库配置',
      status: 'active',
      favorite: 0,
      message_count: 1,
      last_active_at: '2026-10-05T10:01:00.000Z',
      created_at: '2026-10-05T10:00:00.000Z',
      updated_at: '2026-10-05T10:00:00.000Z',
    });
    expect(old.id).toBe('old-session-1');
    await Message.create({
      id: 'old-message-1',
      session_id: 'old-session-1',
      role: 'user',
      content: '我们把数据库换成了 Postgres，连接串放在 .env 里',
      favorite: 0,
      created_at: '2026-10-05T10:01:00.000Z',
      updated_at: '2026-10-05T10:01:00.000Z',
    });

    const result = await searchAll('数据库 Postgres');
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits.some((hit) => hit.snippet.includes('Postgres'))).toBe(true);

    // 📌 **清掉** —— 别污染别的用例
    await sequelize.query('DELETE FROM messages WHERE id = ?', {
      type: QueryTypes.DELETE,
      replacements: ['old-message-1'],
    });
    await sequelize.query('DELETE FROM sessions WHERE id = ?', {
      type: QueryTypes.DELETE,
      replacements: ['old-session-1'],
    });
  });
});
