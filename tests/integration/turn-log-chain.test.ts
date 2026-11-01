import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 「全链路日志真的记全了」的集成测试 —— **真图 · 真 SQLite · 假模型**。
 *
 * 覆盖（[12-e E7](../docs/12-e-需求-观测安全与验收.md)）：
 * 一轮对话从用户发起 → 上下文装配 → 模型请求 → 模型响应 →
 * 工具判定 → 工具执行 → 回灌 → 再调模型 → 收尾，**每一步都进日志**。
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 假模型的脚本 */
let script: Array<{ text?: string; tool?: { name: string; args: Record<string, unknown> } }> = [];

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
        // 📌 **辅助模型走 `invoke`**（记忆抽取 / 检索摘要 / 会话摘要 / 技能沉淀）
        invoke: async () => ({
          content: '[{"op":"add","file":"USER","name":"likes-pnpm","body":"用户喜欢用 pnpm"}]',
        }),
        stream: async function* () {
          const step = script.shift();
          if (!step) return;
          if (step.text) yield { text: step.text };
          if (step.tool) {
            yield {
              tool_call_chunks: [
                {
                  index: 0,
                  id: `call_${step.tool.name}`,
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
const { readSessionLog } = await import('../../src/services/turn-log/store');

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
function fakeTool(name: string) {
  return {
    name,
    description: `假工具 ${name}`,
    schema: z.object({ value: z.string().optional() }),
    sensitivity: 'low' as const,
    source: 'builtin' as const,
    enabled: true,
    executor: 'local' as const,
    invoke: (args: unknown) =>
      Promise.resolve({ ok: true, output: `echo:${String((args as { value?: string })?.value)}` }),
  };
}

beforeEach(() => {
  script = [];
  const tool = fakeTool('echo_tool');
  setToolRegistry({
    list: () => [tool],
    get: (name: string) => (name === tool.name ? tool : undefined),
    names: () => [tool.name],
  });
});

async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  return ((await response.json()) as { id: string }).id;
}

/** 发一轮对话并等它结束 */
async function postChat(sessionId: string, text: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  // 📌 **等日志落库** —— 事件是「发射即忘」的异步写
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe('全链路日志真的记全了（[12-e E7](../docs/12-e-需求-观测安全与验收.md)）', () => {
  it('一轮带工具调用的对话 → 从请求到收尾每一步都在', async () => {
    const sessionId = await createSession();
    script.push({ tool: { name: 'echo_tool', args: { value: '你好' } } }, { text: '答完了' });

    await postChat(sessionId, '跑一下那个工具');

    const log = await readSessionLog(sessionId);
    expect(log.turns).toHaveLength(1);
    const events = log.turns[0]?.events ?? [];
    const types = events.map((event) => event.type);

    expect(types).toContain('request.received');
    expect(types).toContain('context.prepared');
    expect(types).toContain('llm.request');
    expect(types).toContain('llm.response');
    expect(types).toContain('tool.decision');
    expect(types).toContain('tool.execute');
    expect(types).toContain('turn.finished');

    // 📌 **顺序是对的** —— 请求在响应之前，工具在模型响应之后
    expect(types.indexOf('llm.request')).toBeLessThan(types.indexOf('llm.response'));
    expect(types.indexOf('llm.response')).toBeLessThan(types.indexOf('tool.decision'));
    expect(types.indexOf('tool.execute')).toBeLessThan(types.indexOf('turn.finished'));

    // 📌 **模型请求体是全的** —— 系统提示词与消息都在
    const request = events.find((event) => event.type === 'llm.request');
    const requestPayload = request?.payload as Record<string, unknown>;
    expect(typeof requestPayload.systemPrompt).toBe('string');
    expect(Array.isArray(requestPayload.messages)).toBe(true);
    expect(Array.isArray(requestPayload.tools)).toBe(true);

    // 📌 **工具入参出参都在** —— 「它到底调了什么」看得见
    const executed = events.find((event) => event.type === 'tool.execute');
    const executedPayload = executed?.payload as Record<string, unknown>;
    expect(executedPayload.tool).toBe('echo_tool');
    expect(JSON.stringify(executedPayload.args)).toContain('你好');
    expect(String(executedPayload.output)).toContain('echo:');
  });

  it('辅助模型调用（记忆抽取）也要进日志', async () => {
    const sessionId = await createSession();
    script.push({ text: '记住了' });

    // 📌 **「记住」命中 T1 信号** —— 轮次结束后会触发自动抽取
    await postChat(sessionId, '记住我喜欢用 pnpm');

    const log = await readSessionLog(sessionId);
    const events = log.turns[0]?.events ?? [];
    const types = events.map((event) => event.type);
    expect(types).toContain('llm.utility');
    expect(types).toContain('memory.extracted');

    // 📌 **这一轮可能还有别的辅助调用**（检索摘要）——
    //    按用途找，别拿第一条当答案
    const utility = events.find(
      (event) =>
        event.type === 'llm.utility' &&
        (event.payload as Record<string, unknown>)?.purpose === '记忆抽取',
    );
    const payload = utility?.payload as Record<string, unknown>;
    expect(payload.model).toBe('fake-model');
    expect(String(payload.output)).toContain('likes-pnpm');
  });

  it('⚠️ 密钥不进日志（模型请求体里的 api_key 要打码）', async () => {
    const sessionId = await createSession();
    script.push({ text: '答完了' });
    await postChat(sessionId, '你好');

    const log = await readSessionLog(sessionId);
    const request = log.turns[0]?.events.find((event) => event.type === 'llm.request');
    const payload = request?.payload as Record<string, unknown>;
    // 📌 **请求体里压根没有 apiKey 这个字段** —— 我们只记模型名与端点
    expect(payload.apiKey).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('fake-key');
  });
});
