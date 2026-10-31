import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { useTempDatabase } from '../fixtures/db';

/**
 * 成本记账的集成测试 —— **真 SQLite · 假模型**。
 *
 * 覆盖（[12-d D4](../docs/12-d-需求-记忆与配置.md)）：
 * - 每轮对话后 `cost_logs` 里有对应的一条记录（token + 费用）
 * - `/usage` 返回本月 token 与花费
 * - 单价没配 → 费用是 0，但** token 数是准的**
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
          // 📌 **带 usage** —— 记账就靠它
          yield {
            text: '',
            usage_metadata: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
          };
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- 假模型的签名要求
        invoke: async () => ({ content: '一段摘要' }),
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
const { monthlyUsage, sessionUsage, recordUsage } = await import('../../src/services/cost');
const { CostLog } = await import('../../src/models/cost-log.model');

/** 一条成本记录（**显式写字段** —— 动态 import 的类型推不出来） */
interface CostRow {
  usage_scope: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cost: number;
  session_id: string | null;
}

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

async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

describe('成本记账（[12-d D4](../docs/12-d-需求-记忆与配置.md)）', () => {
  it('每轮对话后有一条 cost_logs 记录', async () => {
    const sessionId = await createSession();
    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      }),
    });
    await response.text();

    // 📌 **记账在流结束之后** —— 轮询等一下
    let rows: CostRow[] = [];
    for (let i = 0; i < 50; i += 1) {
      rows = (await CostLog.findAll({ where: { session_id: sessionId } })) as unknown as CostRow[];
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]?.usage_scope).toBe('chat');
    expect(rows[0]?.model).toBe('fake-model');
    expect(rows[0]?.provider).toBe('anthropic');
    expect(rows[0]?.prompt_tokens).toBe(120);
    expect(rows[0]?.completion_tokens).toBe(30);
    // ⚠️ **单价没配 → 费用 0**（token 数是准的）
    expect(rows[0]?.cost).toBe(0);
  });

  it('本月用量与会话用量都对得上', async () => {
    const month = await monthlyUsage();
    expect(month.totalTokens).toBeGreaterThanOrEqual(150);
    expect(month.entries).toBeGreaterThanOrEqual(1);

    const rows = (await CostLog.findAll({ limit: 1 })) as unknown as CostRow[];
    const session = await sessionUsage(rows[0]?.session_id ?? '');
    expect(session.totalTokens).toBeGreaterThanOrEqual(150);
  });

  it('手动记一条也能落库', async () => {
    await recordUsage({
      sessionId: null,
      messageId: null,
      scope: 'memory',
      model: 'fake-model',
      inputTokens: 10,
      outputTokens: 5,
    });
    const rows = (await CostLog.findAll({
      where: { usage_scope: 'memory' },
    })) as unknown as CostRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prompt_tokens).toBe(10);
    expect(rows[0]?.completion_tokens).toBe(5);
  });
});
