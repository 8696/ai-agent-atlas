import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 人工确认闸的**参数指纹**（见 [12-b B5](../docs/12-b-需求-对话与编排.md)）。
 *
 * 覆盖：
 * - 批准时带上指纹 → 工具正常执行
 * - ⚠️ **批准时指纹对不上 → 重新弹确认**（不能沿用旧的批准）
 */

// ⚠️ **静音日志**
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

interface Step {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  when?: (lastText: string) => boolean;
}

let script: Step[] = [];
const usedSteps = new Set<Step>();
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
                  id: `call_${step.tool.name}_${executed.length}`,
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

// ⚠️ **先切走数据目录**
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');
const { setToolRegistry } = await import('../../src/tools/registry');

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

/** 一个高危假工具 */
function dangerTool() {
  return {
    name: 'danger_tool',
    description: '高危工具',
    schema: z.object({ value: z.string().optional() }),
    sensitivity: 'high' as const,
    source: 'builtin' as const,
    enabled: true,
    executor: 'local' as const,
    invoke: () => {
      executed.push('danger_tool');
      return Promise.resolve({ ok: true, output: '干完了' });
    },
  };
}

beforeEach(() => {
  script = [];
  usedSteps.clear();
  executed = [];
  const danger = dangerTool();
  setToolRegistry({
    list: () => [danger],
    get: (name: string) => (name === 'danger_tool' ? danger : undefined),
    names: () => ['danger_tool'],
  });
});

interface Chunk {
  type: string;
  [key: string]: unknown;
}

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

async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

function postConfirm(sessionId: string, approved: boolean, fingerprint?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/chat/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, approved, ...(fingerprint ? { fingerprint } : {}) }),
  });
}

describe('确认闸的参数指纹（[12-b B5](../docs/12-b-需求-对话与编排.md)）', () => {
  it('批准时带上指纹 → 工具正常执行', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('干活'),
        tool: { name: 'danger_tool', args: { value: 'x' } },
      },
      { when: (text) => !text.includes('干活'), text: '干完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '干活' }] }],
      }),
    });

    let confirmed = false;
    for await (const chunk of readChunks(response)) {
      if (chunk.type === 'data-pending-confirm' && !confirmed) {
        confirmed = true;
        const payload = chunk['data'] as { fingerprint?: string };
        expect(payload.fingerprint).toBeTruthy();
        await postConfirm(sessionId, true, payload.fingerprint);
      }
    }

    expect(confirmed).toBe(true);
    expect(executed).toContain('danger_tool');
  });

  it('⚠️ 指纹对不上 → 重新弹确认，工具不执行', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('干活'),
        tool: { name: 'danger_tool', args: { value: 'x' } },
      },
      { when: (text) => !text.includes('干活'), text: '干完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '干活' }] }],
      }),
    });

    const pending: Array<{ fingerprint?: string }> = [];
    let approvedOnce = false;
    for await (const chunk of readChunks(response)) {
      if (chunk.type === 'data-pending-confirm') {
        const payload = chunk['data'] as { fingerprint?: string };
        pending.push(payload);
        if (!approvedOnce) {
          approvedOnce = true;
          // 📌 **故意带一个错的指纹** —— 参数变了，不能沿用旧的批准
          await postConfirm(sessionId, true, 'deadbeefdeadbeef');
        } else {
          // 📌 **第二次弹确认 → 用正确的指纹批准**
          await postConfirm(sessionId, true, payload.fingerprint);
        }
      }
    }

    // 📌 **弹了两次** —— 第一次的参数指纹没对上
    expect(pending.length).toBeGreaterThanOrEqual(2);
    // 📌 **最终工具还是执行了**（第二次批准是对的）
    expect(executed).toContain('danger_tool');
  });

  it('⚠️ 不带指纹 → 不当成批准，重新弹确认', async () => {
    const sessionId = await createSession();
    script = [
      {
        when: (text) => text.includes('干活'),
        tool: { name: 'danger_tool', args: { value: 'x' } },
      },
      { when: (text) => !text.includes('干活'), text: '干完了' },
    ];

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '干活' }] }],
      }),
    });

    const pending: Array<{ fingerprint?: string }> = [];
    let first = true;
    for await (const chunk of readChunks(response)) {
      if (chunk.type === 'data-pending-confirm') {
        const payload = chunk['data'] as { fingerprint?: string };
        pending.push(payload);
        if (first) {
          first = false;
          // ⚠️ **故意不带指纹** —— 「没传」不能等于「沿用旧的批准」
          await postConfirm(sessionId, true);
        } else {
          await postConfirm(sessionId, true, payload.fingerprint);
        }
      }
    }

    // 📌 **重新弹了一次** —— 第一次的批准没带指纹，不能算数
    expect(pending.length).toBeGreaterThanOrEqual(2);
    // 📌 **第二次带对指纹 → 工具执行了**
    expect(executed).toContain('danger_tool');
  });
});
