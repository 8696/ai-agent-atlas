import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 沙箱代码（`execute_code`）的集成测试 —— **真沙箱 · 真 SQLite · 假模型**。
 *
 * 覆盖（[12-c C2](../docs/12-c-需求-工具技能与扩展.md) 的验收项）：
 * - 脚本跑起来 → 返回值回到对话里
 * - 脚本里 RPC 调工具 → **中间结果不进对话上下文**，但**流水里能逐条看到**
 * - ⚠️ 脚本里调高危工具 → 被拒（**沙箱不是确认闸的后门**）
 * - ⚠️ 脚本碰不到文件系统与网络
 * - `execute_code` 自己是 high 档 → 默认弹确认
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 假模型的一次输出 */
interface Step {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  when?: (lastText: string) => boolean;
}

/** 假模型的脚本 */
let script: Step[] = [];
/** 用掉的步骤 */
const usedSteps = new Set<Step>();
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
                  id: `call_${step.tool.name}_${executed.length}_${usedSteps.size}`,
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
const { executeCodeTool } = await import('../../src/tools/builtin/code');

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
    invoke: (args: unknown) => {
      executed.push(name);
      const value = (args as { value?: string }).value ?? '';
      return Promise.resolve({ ok: true, output: `${name} 跑完了：${value}` });
    },
  };
}

beforeEach(() => {
  script = [];
  usedSteps.clear();
  executed = [];
  const safe = fakeTool('safe_tool', 'low');
  const danger = fakeTool('danger_tool', 'high');
  setToolRegistry({
    list: () => [safe, danger, executeCodeTool],
    get: (name: string) =>
      [safe, danger, executeCodeTool].find((tool) => tool.name === name),
    names: () => ['safe_tool', 'danger_tool', 'execute_code'],
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

/** 批准 / 取消 */
function postConfirm(sessionId: string, approved: boolean): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/chat/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, approved }),
  });
}

describe('沙箱代码（[12-c C2](../docs/12-c-需求-工具技能与扩展.md)）', () => {
  it('脚本跑起来 → 返回值回到对话里', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('算个数'),
        tool: {
          name: 'execute_code',
          args: { code: 'return { sum: 1 + 2, name: "atlas" };' },
        },
      },
      { when: (text) => !text.includes('算个数'), text: '算完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '算个数' }] }],
      }),
    });

    const chunks: Chunk[] = [];
    let confirmed = false;
    for await (const chunk of readChunks(response)) {
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        // 📌 **`execute_code` 是 high 档 → 默认弹确认**
        const payload = chunk['data'] as { toolName?: string };
        expect(payload.toolName).toBe('execute_code');
        await postConfirm(sessionId, true);
      }
    }

    expect(confirmed).toBe(true);

    const card = chunks
      .filter((chunk) => chunk.type === 'data-tool-call')
      .at(-1)?.['data'] as { toolName?: string; status?: string; output?: string } | undefined;
    expect(card?.toolName).toBe('execute_code');
    expect(card?.status).toBe('success');
    // 📌 **脚本的返回值回到了对话里**
    expect(card?.output).toContain('atlas');
  });

  it('脚本里 RPC 调工具 → 中间结果不进对话，但流水里能逐条看到', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('跑个脚本'),
        tool: {
          name: 'execute_code',
          args: {
            code:
              "const a = await atlas.call('safe_tool', { value: 'x' });" +
              "return { got: a.length };",
          },
        },
      },
      { when: (text) => !text.includes('跑个脚本'), text: '跑完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '跑个脚本' }] }],
      }),
    });

    let confirmed = false;
    for await (const chunk of readChunks(response)) {
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        await postConfirm(sessionId, true);
      }
    }

    // 📌 **工具真的被调了**
    expect(executed).toContain('safe_tool');

    // 📌 **流水里能逐条看到脚本里的 RPC 调用**（见 [12-c C6](../docs/12-c-需求-工具技能与扩展.md)）
    const { sequelize } = await import('../../src/db');
    const { QueryTypes } = await import('sequelize');
    const rows = await sequelize.query<{ tool_name: string; message_id: string }>(
      'SELECT tool_name, message_id FROM tool_call_logs WHERE tool_name = ?',
      { type: QueryTypes.SELECT, replacements: ['safe_tool'] },
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // 📌 **消息 id 带 `#exec` 后缀** —— 一眼看出是脚本里调的
    expect(rows.some((row) => row.message_id.endsWith('#exec'))).toBe(true);
  });

  it('⚠️ 脚本里调高危工具 → 被拒（沙箱不是确认闸的后门）', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('跑个脚本'),
        tool: {
          name: 'execute_code',
          args: {
            code:
              "try {" +
              "  await atlas.call('danger_tool', { value: 'x' });" +
              "  return '居然成功了';" +
              "} catch (err) { return '被拒: ' + err.message; }",
          },
        },
      },
      { when: (text) => !text.includes('跑个脚本'), text: '跑完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '跑个脚本' }] }],
      }),
    });

    const chunks: Chunk[] = [];
    let confirmed = false;
    for await (const chunk of readChunks(response)) {
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        await postConfirm(sessionId, true);
      }
    }

    // 📌 **高危工具根本没执行**
    expect(executed).not.toContain('danger_tool');

    const card = chunks
      .filter((chunk) => chunk.type === 'data-tool-call')
      .at(-1)?.['data'] as { output?: string } | undefined;
    expect(card?.output).toContain('被拒');
  });

  it('⚠️ 脚本碰不到文件系统与网络', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('跑个脚本'),
        tool: {
          name: 'execute_code',
          args: {
            code:
              "return { require: typeof require, fetch: typeof fetch," +
              " process: typeof process };",
          },
        },
      },
      { when: (text) => !text.includes('跑个脚本'), text: '跑完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '跑个脚本' }] }],
      }),
    });

    const chunks: Chunk[] = [];
    let confirmed = false;
    for await (const chunk of readChunks(response)) {
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        await postConfirm(sessionId, true);
      }
    }

    const card = chunks
      .filter((chunk) => chunk.type === 'data-tool-call')
      .at(-1)?.['data'] as { output?: string } | undefined;
    // 📌 **都没有** —— 脚本只能通过 atlas.call() 碰外面的世界
    expect(card?.output).toContain('"require":"undefined"');
    expect(card?.output).toContain('"fetch":"undefined"');
    expect(card?.output).toContain('"process":"undefined"');
  });

  it('⚠️ 脚本不能靠构造函数逃出沙箱（宿主对象不外泄）', async () => {
    const sessionId = await createSession();
    // 📌 **每一条都是「宿主对象 → 宿主 Function」的路径** ——
    //    改动前它们能拿到宿主 `process`（见 `assets/sandbox/runner.mjs` 的引导代码注释）。
    //    ⚠️ **`codeGeneration.strings = false` 只管上下文 realm 的 `Function`** ——
    //    宿主函数挂进上下文就等于把宿主 `Function` 构造器一起送进去。
    const escapes = [
      "atlas.call.constructor('return process')()",
      "atlas.constructor.constructor('return process')()",
      "console.log.constructor('return process')()",
      "setTimeout.constructor('return process')()",
      "globalThis.constructor.constructor('return process')()",
    ];
    const body = escapes
      .map(
        (expr, index) =>
          `try { r${index} = 'LEAKED: ' + String(${expr}).slice(0, 60); }` +
          ` catch (err) { r${index} = 'BLOCKED'; }`,
      )
      .join('\n');
    // 📌 **异常那条也要测** —— 宿主 `Error` 的 `.constructor` 同样是宿主 `Function`
    const errorProbe =
      "try { await atlas.call('nope_tool', {}); r9 = 'LEAKED: 没报错'; } catch (err) {" +
      " try { r9 = 'LEAKED: ' + String(err.constructor.constructor('return process')()); }" +
      " catch (e) { r9 = 'BLOCKED'; } }";
    const code =
      `${body}\n${errorProbe}\n` +
      `return { ${escapes.map((_, index) => `r${index}`).join(', ')}, r9 };`;

    script = [
      {
        when: (text) => text.includes('跑个脚本'),
        tool: { name: 'execute_code', args: { code } },
      },
      { when: (text) => !text.includes('跑个脚本'), text: '跑完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '跑个脚本' }] }],
      }),
    });

    const chunks: Chunk[] = [];
    let confirmed = false;
    for await (const chunk of readChunks(response)) {
      chunks.push(chunk);
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        await postConfirm(sessionId, true);
      }
    }

    const card = chunks
      .filter((chunk) => chunk.type === 'data-tool-call')
      .at(-1)?.['data'] as { output?: string } | undefined;
    // 📌 **一条都不许漏**
    expect(card?.output).not.toContain('LEAKED');
    for (let index = 0; index < escapes.length; index += 1) {
      expect(card?.output).toContain(`"r${index}":"BLOCKED"`);
    }
    expect(card?.output).toContain('"r9":"BLOCKED"');
  });
});
