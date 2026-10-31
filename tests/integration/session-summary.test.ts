import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { useTempDatabase } from '../fixtures/db';

/**
 * 会话摘要与压缩的集成测试 —— **真 SQLite · 假模型**。
 *
 * 覆盖（[12-d D1](../docs/12-d-需求-记忆与配置.md)）：
 * - 手动压缩 → 早期消息折成摘要，**边界之前不再喂原文**
 * - 边界按消息 id 定位（**按下标裁会裁错**）
 * - 消息表不删（**历史仍然翻得到**）
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
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
        // eslint-disable-next-line @typescript-eslint/require-await -- 假模型的 stream 签名要求
        stream: async function* () {
          yield { text: '好' };
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- 假模型的签名要求
        invoke: async () => ({ content: '【摘要】用户在做记忆系统的事' }),
      };
      return model;
    },
  };
});

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { compressSession, loadSummary, trimByBoundary } =
  await import('../../src/services/session-summary');
const { createSession } = await import('../../src/services/session');
const { Message } = await import('../../src/models/message.model');
const { utcNow } = await import('../../src/lib/time');

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
});

/** 造一条历史（**带 id** —— 摘要边界靠 id 定位） */
async function seedHistory(
  sessionId: string,
  count: number,
): Promise<Array<HumanMessage | AIMessage>> {
  const out: Array<HumanMessage | AIMessage> = [];
  for (let i = 0; i < count; i += 1) {
    const id = `msg-${sessionId}-${i}`;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const content = `${role === 'user' ? '问' : '答'}${i}`;
    await Message.create({
      id,
      session_id: sessionId,
      role,
      content,
      parts: null,
      tool_calls: null,
      tool_results: null,
      attachments: null,
      favorite: 0,
      metadata: null,
      created_at: utcNow(),
      updated_at: utcNow(),
    });
    out.push(role === 'user' ? new HumanMessage({ content, id }) : new AIMessage({ content, id }));
  }
  return out;
}

describe('会话摘要与压缩（[12-d D1](../docs/12-d-需求-记忆与配置.md)）', () => {
  it('手动压缩 → 早期消息折成摘要', async () => {
    const session = await createSession();
    const messages = await seedHistory(session.id, 6);

    const result = await compressSession(session.id, messages, { manual: true });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('摘要');

    const state = await loadSummary(session.id);
    expect(state.summary).toContain('摘要');
    // 📌 **边界指向被折掉的那条消息**（最后一条用户消息要留着 —— 那是要回答的问题）
    expect(state.boundary).toBe('msg-' + session.id + '-3');
  });

  it('⚠️ 边界之前不再喂原文', async () => {
    const session = await createSession();
    const messages = await seedHistory(session.id, 6);
    await compressSession(session.id, messages, { manual: true });

    const state = await loadSummary(session.id);
    const trimmed = trimByBoundary(messages, state);

    // 📌 **只留下边界之后的消息**（最后一条用户消息 + 它的回答）
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0]?.id).toBe('msg-' + session.id + '-4');
    // ⚠️ **被折掉的那几条里，一条原文都不许留**
    expect(trimmed.some((message) => message.id === 'msg-' + session.id + '-0')).toBe(false);
  });

  it('📌 消息表不删（历史仍然翻得到）', async () => {
    const session = await createSession();
    const messages = await seedHistory(session.id, 6);
    await compressSession(session.id, messages, { manual: true });

    const rows = await Message.findAll({ where: { session_id: session.id } });
    expect(rows).toHaveLength(6);
  });

  it('⚠️ 没有可压缩的内容 → 不白花一次模型调用', async () => {
    const session = await createSession();
    const messages = await seedHistory(session.id, 1);
    const result = await compressSession(session.id, messages, { manual: true });
    expect(result.ok).toBe(true);
    expect(result.folded).toBe(0);
  });
});
