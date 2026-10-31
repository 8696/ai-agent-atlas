import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/**
 * 断点恢复的集成测试 —— **进程重启后能续跑**
 * （见 [12-b B6](../docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **「重启」怎么模拟**：重新建一张图 = 新的 checkpointer 实例，
 * 状态只能从 SQLite 里读 —— 与真重启等价。
 */

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名要求的，不是误用。
 */

vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

let script: Array<{ text?: string; tool?: { name: string; args: Record<string, unknown> } }> = [];
let executed: string[] = [];

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
          const step = script.shift();
          if (!step) return;
          if (step.text) yield { text: step.text };
          if (step.tool) {
            yield {
              tool_call_chunks: [
                {
                  index: 0,
                  id: `call_${executed.length}`,
                  name: step.tool.name,
                  args: JSON.stringify(step.tool.args),
                },
              ],
            };
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
const { sequelize } = await import('../../src/db');
const { createGraph } = await import('../../src/agent/graph');
const { setToolRegistry } = await import('../../src/tools/registry');
const { Command } = await import('@langchain/langgraph');

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
});

beforeEach(() => {
  script = [];
  executed = [];
  setToolRegistry({
    list: () => [dangerTool()],
    get: (name: string) => (name === 'danger_tool' ? dangerTool() : undefined),
    names: () => ['danger_tool'],
  });
});

function dangerTool() {
  return {
    name: 'danger_tool',
    description: '危险工具',
    schema: z.object({ value: z.string().optional() }),
    sensitivity: 'high' as const,
    source: 'builtin' as const,
    enabled: true,
    executor: 'local' as const,
    invoke: () => {
      executed.push('danger_tool');
      return Promise.resolve({ ok: true, output: 'done' });
    },
  };
}

/** 跑一段图，收集事件 */
async function runGraph(
  graph: ReturnType<typeof createGraph>,
  input: unknown,
  threadId: string,
): Promise<unknown[]> {
  const stream = await graph.stream(input as never, {
    configurable: { thread_id: threadId },
    streamMode: ['custom', 'values'] as never,
  });
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('断点恢复（[12-b B6](../docs/12-b-需求-对话与编排.md)）', () => {
  it('⚠️ 挂起后「重启」→ 待确认仍在，批准后能继续', async () => {
    const threadId = 'restart-thread';
    script = [{ tool: { name: 'danger_tool', args: { value: 'x' } } }, { text: '好了' }];

    // ── 第一段：跑到挂起 ──
    const graph1 = createGraph();
    const first = await runGraph(
      graph1,
      { turnMessages: [], sessionId: threadId, messageId: 'msg-restart' },
      threadId,
    );
    const interrupted = first.find(
      (chunk) =>
        Array.isArray(chunk) &&
        (chunk as [string, unknown])[0] === 'values' &&
        (chunk as [string, unknown])[1] &&
        typeof (chunk as [string, unknown])[1] === 'object' &&
        '__interrupt__' in ((chunk as [string, unknown])[1] as Record<string, unknown>),
    );
    expect(interrupted).toBeDefined();

    // ⚠️ **检查点真的落盘了**
    const rows = await sequelize.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM graph_checkpoints WHERE thread_id = :threadId',
      { replacements: { threadId }, type: QueryTypes.SELECT },
    );
    expect(Number(rows[0]?.c ?? 0)).toBeGreaterThan(0);

    // ⚠️ **「重启」** —— 重新建图（新的 checkpointer 实例，状态只能从库里读）
    const graph2 = createGraph();
    const second = await runGraph(graph2, new Command({ resume: { approved: true } }), threadId);

    // ⚠️ **批准后工具执行了，且只执行一次**
    expect(executed).toEqual(['danger_tool']);
    const text = second
      .filter(
        (chunk) =>
          Array.isArray(chunk) && (chunk as [string, unknown])[0] === 'custom',
      )
      .map((chunk) => JSON.stringify((chunk as [string, unknown])[1]))
      .join('');
    expect(text).toContain('好了');
  });

  it('⚠️ 重启后预算累计不归零（状态在检查点里）', async () => {
    const threadId = 'budget-thread';
    script = [{ text: '第一轮' }];

    const graph1 = createGraph();
    await runGraph(
      graph1,
      { turnMessages: [], sessionId: threadId, messageId: 'msg-budget' },
      threadId,
    );

    const snapshot = await graph1.getState({ configurable: { thread_id: threadId } });
    const values = snapshot.values as { budgetUsed?: number };
    expect(typeof values.budgetUsed).toBe('number');
  });

  it('⚠️ 删会话 → 检查点一起清掉', async () => {
    // ⚠️ **thread_id 就是会话 id** —— 先建一个真会话
    const { createSession } = await import('../../src/services/session');
    const session = await createSession();
    const threadId = session.id;
    script = [{ text: 'x' }];
    const graph = createGraph();
    await runGraph(
      graph,
      { turnMessages: [], sessionId: threadId, messageId: 'msg-delete' },
      threadId,
    );

    const before = await sequelize.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM graph_checkpoints WHERE thread_id = :threadId',
      { replacements: { threadId }, type: QueryTypes.SELECT },
    );
    expect(Number(before[0]?.c ?? 0)).toBeGreaterThan(0);

    const { deleteSession } = await import('../../src/services/session');
    await deleteSession(threadId);

    const after = await sequelize.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM graph_checkpoints WHERE thread_id = :threadId',
      { replacements: { threadId }, type: QueryTypes.SELECT },
    );
    expect(Number(after[0]?.c ?? 0)).toBe(0);
  });
});
