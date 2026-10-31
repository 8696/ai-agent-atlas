import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 子代理的集成测试 —— **真图 · 真 SQLite · 假模型**。
 *
 * 覆盖（[12-b B10](../docs/12-b-需求-对话与编排.md) 的验收项）：
 * - 派发子代理 → 跑完 → 摘要回灌给主 Agent
 * - 子代理看不到主对话的历史（只有 task）
 * - 子代理返回的是摘要，不是全量过程
 * - 子代理要跑高危工具 → **弹确认**（不自动放行）
 * - 多个子代理 → 并行派发
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 假模型的一次输出 */
interface Step {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  /** 什么时候用这一步（**看最后一条消息的正文**） */
  when?: (lastText: string) => boolean;
}

/** 假模型的脚本 */
let script: Step[] = [];

/** 用掉的步骤 */
const usedSteps = new Set<Step>();

/** 每次模型调用看到的消息（**用来验「子代理看不到主对话历史」**） */
let seen: Array<{ lastText: string; texts: string[] }> = [];

/** 被调用过的工具 */
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
        stream: async function* (messages: Array<{ content?: unknown }>) {
          const texts = messages.map((message) =>
            typeof message.content === 'string' ? message.content : '',
          );
          const lastText = texts[texts.length - 1] ?? '';
          seen.push({ lastText, texts });

          const step = script.find(
            (item) => !usedSteps.has(item) && (!item.when || item.when(lastText)),
          );
          if (!step) return;
          usedSteps.add(step);

          if (step.text) yield { text: step.text };
          if (step.tool) {
            yield {
              tool_call_chunks: [
                {
                  index: 0,
                  id: `call_${step.tool.name}_${executed.length}_${seen.length}`,
                  name: step.tool.name,
                  args: JSON.stringify(step.tool.args),
                },
              ],
            };
          }
        },
        invoke: async () => ({ content: '' }),
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
const { spawnSubagentTool, clearSubagentMemo } = await import('../../src/agent/subagent');

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

/** 一个假工具 */
function fakeTool(name: string, sensitivity: 'low' | 'normal' | 'high') {
  return {
    name,
    description: `假工具 ${name}`,
    schema: z.object({ value: z.string().optional() }),
    sensitivity,
    source: 'builtin' as const,
    enabled: true,
    executor: 'local' as const,
    invoke: () => {
      executed.push(name);
      return Promise.resolve({ ok: true, output: `${name} 跑完了` });
    },
  };
}

beforeEach(() => {
  script = [];
  usedSteps.clear();
  seen = [];
  executed = [];
  clearSubagentMemo();
  const safe = fakeTool('safe_tool', 'low');
  const danger = fakeTool('danger_tool', 'high');
  setToolRegistry({
    list: () => [safe, danger, spawnSubagentTool],
    get: (name: string) =>
      [safe, danger, spawnSubagentTool].find((tool) => tool.name === name),
    names: () => ['safe_tool', 'danger_tool', 'spawn_subagent'],
  });
});

/** 一个 chunk */
interface Chunk {
  type: string;
  [key: string]: unknown;
}

/** 读 SSE 流 */
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

/** 建一个会话 */
async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** 发一轮对话（**可以带历史**） */
function postChat(
  sessionId: string,
  history: Array<{ role: string; parts: Array<{ type: string; text: string }> }>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, messages: history }),
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

describe('子代理（[12-b B10](../docs/12-b-需求-对话与编排.md)）', () => {
  it('派发子代理 → 跑完 → 摘要回灌给主 Agent', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('帮我查两件事'),
        tool: { name: 'spawn_subagent', args: { task: '查一下 A', name: 'A' } },
      },
      { when: (text) => text.includes('查一下 A'), text: 'A 的结果' },
      { when: (text) => !text.includes('查一下 A'), text: '都查完了' },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '帮我查两件事' }] },
    ]);
    const chunks: Chunk[] = [];
    for await (const chunk of readChunks(response)) chunks.push(chunk);

    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('都查完了');

    // 📌 **子代理的卡片在流里**（名字 · 任务 · 状态 · 摘要）
    const cards = chunks.filter((chunk) => chunk.type === 'data-tool-call');
    const card = cards.at(-1)?.['data'] as
      | { toolName?: string; status?: string; output?: string }
      | undefined;
    expect(card?.toolName).toBe('spawn_subagent');
    expect(card?.status).toBe('success');
    expect(card?.output).toContain('A 的结果');

    // 📌 **派发有审计**
    const { sequelize } = await import('../../src/db');
    const { QueryTypes } = await import('sequelize');
    const rows = await sequelize.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'SUBAGENT_SPAWNED'",
      { type: QueryTypes.SELECT },
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('⚠️ 子代理看不到主对话的历史（只有 task）', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('帮我查两件事'),
        tool: { name: 'spawn_subagent', args: { task: '查一下 A', name: 'A' } },
      },
      { when: (text) => text.includes('查一下 A'), text: 'A 的结果' },
      { when: (text) => !text.includes('查一下 A'), text: '都查完了' },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '先记住我的秘密：ABC123' }] },
      { role: 'user', parts: [{ type: 'text', text: '帮我查两件事' }] },
    ]);
    // 📌 **读完就行** —— 这里只看模型看到什么
    for await (const chunk of readChunks(response)) {
      void chunk;
    }

    // 📌 **子代理那一次调用里没有主对话的历史**
    const subagentCall = seen.find((item) => item.lastText.includes('查一下 A'));
    expect(subagentCall).toBeDefined();
    expect(subagentCall?.texts.join('\n')).not.toContain('ABC123');
  });

  it('⚠️ 子代理返回的是摘要，不是全量过程', async () => {
    const sessionId = await createSession();
    const long = 'x'.repeat(5000);
    script = [
      {
        when: (text) => text.includes('帮我查'),
        tool: { name: 'spawn_subagent', args: { task: '查一下 A' } },
      },
      { when: (text) => text.includes('查一下 A'), text: long },
      { when: (text) => !text.includes('查一下 A'), text: '好了' },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '帮我查' }] },
    ]);
    const chunks: Chunk[] = [];
    for await (const chunk of readChunks(response)) chunks.push(chunk);

    const card = chunks
      .filter((chunk) => chunk.type === 'data-tool-call')
      .at(-1)?.['data'] as { output?: string } | undefined;
    // 📌 **摘要被截断了**（上限 2000 字符）
    expect((card?.output ?? '').length).toBeLessThan(2600);
  });

  it('⚠️ 子代理要跑高危工具 → 弹确认（不自动放行）', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('跑个危险活'),
        tool: { name: 'spawn_subagent', args: { task: '跑个危险活', name: '危险代理' } },
      },
      {
        when: (text) => text.includes('跑个危险活'),
        tool: { name: 'danger_tool', args: { value: 'x' } },
      },
      { when: (text) => !text.includes('跑个危险活'), text: '都查完了' },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '跑个危险活' }] },
    ]);

    const chunks: Chunk[] = [];
    let confirmed = false;
    // ⚠️ **不能 `break` 出 for-await** —— 那会把流生成器关掉
    for await (const chunk of readChunks(response)) {
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        const payload = chunk['data'] as { toolName?: string };
        // 📌 **弹的是子代理要用的那个工具**
        expect(payload.toolName).toBe('danger_tool');
        await postConfirm(sessionId, true);
      }
    }

    expect(confirmed).toBe(true);
    // ⚠️ **批准之后才执行**
    expect(executed).toContain('danger_tool');
  });

  it('⚠️ 取消 → 子代理的危险工具没执行', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('跑个危险活'),
        tool: { name: 'spawn_subagent', args: { task: '跑个危险活' } },
      },
      {
        when: (text) => text.includes('跑个危险活'),
        tool: { name: 'danger_tool', args: { value: 'x' } },
      },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '跑个危险活' }] },
    ]);

    let decided = false;
    for await (const chunk of readChunks(response)) {
      if (chunk.type === 'data-pending-confirm' && !decided) {
        decided = true;
        await postConfirm(sessionId, false);
      }
    }

    expect(decided).toBe(true);
    expect(executed).not.toContain('danger_tool');
  });

  it('⚠️ 主对话看到的耗时不含子代理挂在确认框上的等待', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('跑个危险活'),
        tool: { name: 'spawn_subagent', args: { task: '跑个危险活', name: '危险代理' } },
      },
      {
        when: (text) => text.includes('跑个危险活'),
        tool: { name: 'danger_tool', args: { value: 'x' } },
      },
      { when: (text) => !text.includes('跑个危险活'), text: '都查完了' },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '跑个危险活' }] },
    ]);

    // 📌 **人为等 1.2 秒再批准** —— 模拟「人想了会儿才点」
    const humanWaitMs = 1200;
    const chunks: Chunk[] = [];
    let confirmed = false;
    for await (const chunk of readChunks(response)) {
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        await new Promise((resolve) => setTimeout(resolve, humanWaitMs));
        await postConfirm(sessionId, true);
      }
    }

    expect(confirmed).toBe(true);

    // 📌 **派发子代理那张卡片的耗时** —— 是「主 Agent 的感知耗时」，
    //    **不含挂在确认框上的那 1.2 秒**
    const card = chunks
      .filter((chunk) => chunk.type === 'data-tool-call')
      .map((chunk) => chunk['data'] as { toolName?: string; durationMs?: number })
      .find((item) => item.toolName === 'spawn_subagent');
    expect(card).toBeDefined();
    expect(card?.durationMs ?? 0).toBeLessThan(humanWaitMs);
  });

  it('📌 子代理的 token 计入主对话的预算', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('帮我查两件事'),
        tool: { name: 'spawn_subagent', args: { task: '查一下 A', name: 'A' } },
      },
      { when: (text) => text.includes('查一下 A'), text: 'A 的结果' },
      { when: (text) => !text.includes('查一下 A'), text: '都查完了' },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '帮我查两件事' }] },
    ]);
    for await (const chunk of readChunks(response)) {
      void chunk;
    }

    // 📌 **子代理与主对话记在同一个会话下** —— 预算闸按月分桶，
    //    子代理烧的 token 不能从账上消失
    const { sequelize } = await import('../../src/db');
    const { QueryTypes } = await import('sequelize');
    const rows = await sequelize.query<{
      session_id: string;
      message_id: string;
      prompt_tokens: number;
      completion_tokens: number;
    }>(
      'SELECT session_id, message_id, prompt_tokens, completion_tokens FROM cost_logs WHERE session_id = ?',
      { type: QueryTypes.SELECT, replacements: [sessionId] },
    );

    expect(rows.length).toBeGreaterThanOrEqual(2);
    // 📌 **每一条都挂在主会话下**
    expect(rows.every((row) => row.session_id === sessionId)).toBe(true);
    // 📌 **子代理那次的消息 id 带 `subagent:` 前缀**（见 [12-c C6](./12-c-需求-工具技能与扩展.md)）
    expect(rows.some((row) => row.message_id.startsWith('subagent:'))).toBe(true);
  });

  it('⚠️ 一次派两个子代理 → 两个都跑完', async () => {    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('同时查两件事'),
        tool: { name: 'spawn_subagent', args: { task: '查 A', name: '甲' } },
      },
      { when: (text) => text.includes('查 A'), text: 'A 的结果' },
      { when: (text) => text.includes('查 B'), text: 'B 的结果' },
      { when: (text) => !text.includes('查 A') && !text.includes('查 B'), text: '都查完了' },
    ];

    const response = await postChat(sessionId, [
      { role: 'user', parts: [{ type: 'text', text: '同时查两件事' }] },
    ]);
    const chunks: Chunk[] = [];
    for await (const chunk of readChunks(response)) chunks.push(chunk);

    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('都查完了');

    // 📌 **两个子代理都跑过**
    const outputs = chunks
      .filter((chunk) => chunk.type === 'data-tool-call')
      .map((chunk) => (chunk['data'] as { output?: string })?.output ?? '')
      .join('\n');
    expect(outputs).toContain('A 的结果');
  });
});
