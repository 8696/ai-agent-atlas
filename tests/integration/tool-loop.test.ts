import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 工具循环与人工确认闸的集成测试 —— **真图 · 真 SQLite · 假模型**。
 *
 * 覆盖（[12-b B3 ~ B6](../docs/12-b-需求-对话与编排.md)）：
 * - 模型调工具 → 结果回灌 → 继续作答
 * - 高危工具 → 挂起等确认 → 批准才执行
 * - 取消 → 工具没执行，模型收到「用户拒绝」
 * - 工具抛异常 → 整轮不 500
 * - 步数上限 / 同工具连续上限 → 停下来
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 假模型的一次输出 */
interface Step {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
}

/** 假模型的脚本（**每个用例自己排**） */
let script: Step[] = [];

/** 被调用过的工具（**用来验「有没有真的执行」**） */
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
                  id: `call_${step.tool.name}_${executed.length}`,
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

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');
const { setToolRegistry } = await import('../../src/tools/registry');
const { config } = await import('../../src/config');

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

/** 入参取值（**只取字符串** —— 免得模板里塞进对象） */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 一个假工具 */
function fakeTool(
  name: string,
  sensitivity: 'low' | 'normal' | 'high',
  behavior: (args: Record<string, unknown>) => { ok: boolean; output: string },
) {
  return {
    name,
    description: `假工具 ${name}`,
    schema: z.object({ value: z.string().optional() }),
    sensitivity,
    source: 'builtin' as const,
    enabled: true,
    executor: 'local' as const,
    invoke: (args: unknown) => {
      executed.push(name);
      const result = behavior((args ?? {}) as Record<string, unknown>);
      return Promise.resolve(result);
    },
  };
}

beforeEach(() => {
  script = [];
  executed = [];
  setToolRegistry({
    list: () => [
      fakeTool('echo_tool', 'low', (args) => ({ ok: true, output: `echo:${str(args.value)}` })),
      fakeTool('danger_tool', 'high', (args) => ({ ok: true, output: `danger:${str(args.value)}` })),
      fakeTool('boom_tool', 'normal', () => {
        throw new Error('工具炸了');
      }),
    ],
    get: (name: string) =>
      [
        fakeTool('echo_tool', 'low', (args) => ({ ok: true, output: `echo:${str(args.value)}` })),
        fakeTool('danger_tool', 'high', (args) => ({ ok: true, output: `danger:${str(args.value)}` })),
        fakeTool('boom_tool', 'normal', () => {
          throw new Error('工具炸了');
        }),
      ].find((tool) => tool.name === name),
    names: () => ['echo_tool', 'danger_tool', 'boom_tool'],
  });
});

async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** 一个 chunk */
interface Chunk {
  type: string;
  [key: string]: unknown;
}

/** 读 SSE 流（**边读边解析** —— 确认卡片出现时流还没结束） */
async function* readChunks(response: Response): AsyncGenerator<Chunk> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = frame.split('\n').find((item) => item.startsWith('data: '));
      if (line) {
        const payload = line.slice('data: '.length);
        if (payload !== '[DONE]') yield JSON.parse(payload) as Chunk;
      }
      index = buffer.indexOf('\n\n');
    }
  }
}

/** 发一轮对话（**返回 chunk 流**） */
function postChat(sessionId: string, text: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
}

/** 批准 / 取消 */
function postConfirm(sessionId: string, approved: boolean): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/chat/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, approved }),
  });
}

describe('工具调用循环（[12-b B4](../docs/12-b-需求-对话与编排.md)）', () => {
  it('模型调工具 → 结果回灌 → 继续作答', async () => {
    const sessionId = await createSession();
    script = [
      { tool: { name: 'echo_tool', args: { value: 'hi' } } },
      { text: '工具说 hi' },
    ];

    const response = await postChat(sessionId, '用 echo_tool 看一下');
    const chunks: Chunk[] = [];
    for await (const chunk of readChunks(response)) chunks.push(chunk);

    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('工具说 hi');
    expect(executed).toEqual(['echo_tool']);

    // 📌 **工具卡片出现在流里**（B7）
    // ⚠️ **取最后一张** —— 先发「执行中」，跑完再发最终状态（同一个 part id，前端会替换）
    const cards = chunks.filter((chunk) => chunk.type === 'data-tool-call');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    const data = cards.at(-1)?.['data'] as { toolName?: string; status?: string };
    expect(data.toolName).toBe('echo_tool');
    expect(data.status).toBe('success');
  });

  it('⚠️ 工具抛异常 → 整轮不 500，模型收到错误文本', async () => {
    const sessionId = await createSession();
    script = [{ tool: { name: 'boom_tool', args: {} } }, { text: '工具坏了，我知道了' }];

    const response = await postChat(sessionId, '调 boom_tool');
    const chunks: Chunk[] = [];
    for await (const chunk of readChunks(response)) chunks.push(chunk);

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('工具坏了，我知道了');
  });

  it('⚠️ 同工具连续调用到上限 → 停下来', async () => {
    const sessionId = await createSession();
    // ⚠️ **模型一直调同一个工具** —— 看刹车能不能拦住
    script = [
      { tool: { name: 'echo_tool', args: { value: '1' } } },
      { tool: { name: 'echo_tool', args: { value: '2' } } },
      { tool: { name: 'echo_tool', args: { value: '3' } } },
      { text: '不再重复了' },
    ];

    const response = await postChat(sessionId, '一直调 echo_tool');
    const chunks: Chunk[] = [];
    for await (const chunk of readChunks(response)) chunks.push(chunk);

    const limit = config.SAME_TOOL_REPEAT_LIMIT;
    expect(executed.length).toBeLessThanOrEqual(limit);
    expect(chunks.some((chunk) => chunk.type === 'data-notice')).toBe(true);
  });

  it('⚠️ 工具调用步数到上限 → 停下来（`MAX_TOOL_STEPS`）', async () => {
    const sessionId = await createSession();
    // 📌 **每次都换一个工具** —— 绕开「同工具连续上限」，
    //    只让**步数上限**来刹车
    script = [
      { tool: { name: 'echo_tool', args: { value: '1' } } },
      { tool: { name: 'echo_tool', args: { value: '2' } } },
      { tool: { name: 'echo_tool', args: { value: '3' } } },
      { tool: { name: 'echo_tool', args: { value: '4' } } },
      { tool: { name: 'echo_tool', args: { value: '5' } } },
      { tool: { name: 'echo_tool', args: { value: '6' } } },
      { tool: { name: 'echo_tool', args: { value: '7' } } },
      { text: '够了' },
    ];

    const response = await postChat(sessionId, '一直调 echo_tool');
    const chunks: Chunk[] = [];
    for await (const chunk of readChunks(response)) chunks.push(chunk);

    // 📌 **上限就是 `.env` 的 `MAX_TOOL_STEPS`** —— 文档 A5 的验收项引的就是这条
    expect(executed.length).toBeLessThanOrEqual(config.MAX_TOOL_STEPS);
    expect(executed.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => chunk.type === 'data-notice')).toBe(true);
  });
});

describe('工具流水（[12-c C6](../docs/12-c-需求-工具技能与扩展.md)）', () => {
  it('每次工具调用都有流水，状态对得上', async () => {
    const sessionId = await createSession();
    script = [{ tool: { name: 'echo_tool', args: { value: 'hi' } } }, { text: '好了' }];

    const response = await postChat(sessionId, '调 echo_tool');
    // ⚠️ **读完流即可** —— 流水在流结束后写
    for await (const chunk of readChunks(response)) {
      expect(chunk).toBeDefined();
    }

    const { sequelize } = await import('../../src/db');
    const { QueryTypes } = await import('sequelize');
    const rows = await sequelize.query<{ tool_name: string; status: string }>(
      'SELECT tool_name, status FROM tool_call_logs WHERE session_id = :sessionId',
      { replacements: { sessionId }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool_name).toBe('echo_tool');
    expect(rows[0]?.status).toBe('success');
  });

  it('⚠️ 被用户取消的调用，流水状态是 rejected（不是 error）', async () => {
    const sessionId = await createSession();
    script = [{ tool: { name: 'danger_tool', args: { value: 'x' } } }, { text: '不做了' }];

    const response = await postChat(sessionId, '跑 danger_tool');
    const iterator = readChunks(response)[Symbol.asyncIterator]();
    let decided = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'data-pending-confirm' && !decided) {
        decided = true;
        await postConfirm(sessionId, false);
      }
    }

    const { sequelize } = await import('../../src/db');
    const { QueryTypes } = await import('sequelize');
    const rows = await sequelize.query<{ status: string; requires_confirmation: number }>(
      'SELECT status, requires_confirmation FROM tool_call_logs WHERE session_id = :sessionId',
      { replacements: { sessionId }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.requires_confirmation).toBe(1);
  });
});

describe('人工确认闸（[12-b B5](../docs/12-b-需求-对话与编排.md)）', () => {
  it('⚠️ 高危工具 → 弹确认卡片 → 批准后才执行', async () => {
    const sessionId = await createSession();
    script = [{ tool: { name: 'danger_tool', args: { value: 'x' } } }, { text: '已执行' }];

    const response = await postChat(sessionId, '跑 danger_tool');
    const chunks: Chunk[] = [];

    // ⚠️ **不能 `break` 出 for-await** —— 那会把流生成器关掉，
    //    服务端还在跑，客户端却已经不收了
    const iterator = readChunks(response)[Symbol.asyncIterator]();
    let confirmed = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = next.value;
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        const payload = chunk['data'] as { toolName?: string; risk?: string };
        expect(payload.toolName).toBe('danger_tool');
        expect(payload.risk).toContain('高危');

        // ⚠️ **还没批准 → 工具没执行**
        expect(executed).toEqual([]);

        const confirm = await postConfirm(sessionId, true);
        expect(confirm.status).toBe(200);
      }
    }

    // ⚠️ **批准后同一个流继续，工具只执行一次**
    expect(executed).toEqual(['danger_tool']);
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('已执行');
  });

  it('⚠️ 取消 → 工具没有执行，模型收到「用户拒绝」', async () => {
    const sessionId = await createSession();
    script = [{ tool: { name: 'danger_tool', args: { value: 'x' } } }, { text: '好的，不做了' }];

    const response = await postChat(sessionId, '跑 danger_tool');
    const chunks: Chunk[] = [];
    const iterator = readChunks(response)[Symbol.asyncIterator]();
    let decided = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = next.value;
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !decided) {
        decided = true;
        expect(chunks.some((item) => item.type === 'data-pending-confirm')).toBe(true);
        await postConfirm(sessionId, false);
      }
    }

    // ⚠️ **工具没有执行**
    expect(executed).toEqual([]);
    const cards = chunks.filter((chunk) => chunk.type === 'data-tool-call');
    const data = cards.at(-1)?.['data'] as { status?: string } | undefined;
    expect(data?.status).toBe('rejected');
  });

  it('⚠️ 一轮里两个危险工具 → 弹两次确认，各批各的', async () => {
    const sessionId = await createSession();
    script = [
      { tool: { name: 'danger_tool', args: { value: 'a' } } },
      { tool: { name: 'danger_tool', args: { value: 'b' } } },
      { text: '两个都跑完了' },
    ];

    const response = await postChat(sessionId, '跑两次 danger_tool');
    const chunks: Chunk[] = [];
    const iterator = readChunks(response)[Symbol.asyncIterator]();
    let confirms = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = next.value;
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm') {
        confirms += 1;
        // ⚠️ **每一次挂起都要能等一个决定** —— 第二次挂起不能永远挂着
        await postConfirm(sessionId, true);
      }
    }

    expect(confirms).toBe(2);
    expect(executed).toEqual(['danger_tool', 'danger_tool']);
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('两个都跑完了');
  });

  it('⚠️ 被拒绝过的调用不会再来一遍（不追问第二次）', async () => {
    const sessionId = await createSession();
    script = [
      { tool: { name: 'danger_tool', args: { value: 'x' } } },
      { tool: { name: 'danger_tool', args: { value: 'x' } } },
      { text: '不做了' },
    ];

    const response = await postChat(sessionId, '跑 danger_tool');
    const chunks: Chunk[] = [];
    const iterator = readChunks(response)[Symbol.asyncIterator]();
    let decided = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = next.value;
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !decided) {
        decided = true;
        await postConfirm(sessionId, false);
      }
    }

    // ⚠️ **只弹过一次确认**
    const confirms = chunks.filter((chunk) => chunk.type === 'data-pending-confirm');
    expect(confirms).toHaveLength(1);
    expect(executed).toEqual([]);
  });
});
