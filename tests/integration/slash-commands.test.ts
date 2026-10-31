import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { useTempDatabase } from '../fixtures/db';

/**
 * 斜杠命令的集成测试 —— **真 HTTP · 真 SQLite · 假模型**。
 *
 * 覆盖（[12-b B9](../docs/12-b-需求-对话与编排.md)）：
 * - `/help` → 返回命令清单，**没有任何模型调用**
 * - `/unknowncmd` → 明确报错，**不发模型**
 * - `/usage` → 返回本月 token 与花费
 * - `/model` → 列出可用模型
 * - 命令结果落库（**刷新后还在**）
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 模型被调用的次数（**命令必须是 0**） */
let modelCalls = 0;

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
          modelCalls += 1;
          yield { text: '模型不该被调用' };
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

async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** 发一条命令（**当作普通消息发，走同一条通道**） */
async function sendCommand(
  sessionId: string,
  text: string,
): Promise<{ text: string; command: Chunk | undefined }> {
  const response = await fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
  const chunks: Chunk[] = [];
  for await (const chunk of readChunks(response)) chunks.push(chunk);
  const body = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk['delta'])
    .join('');
  return { text: body, command: chunks.find((chunk) => chunk.type === 'data-command') };
}

describe('斜杠命令（[12-b B9](../docs/12-b-需求-对话与编排.md)）', () => {
  it('/help → 返回命令清单，**零模型调用**', async () => {
    const sessionId = await createSession();
    modelCalls = 0;

    const { text, command } = await sendCommand(sessionId, '/help');

    expect(text).toContain('/help');
    expect(text).toContain('/compress');
    expect(text).toContain('/usage');
    // 📌 **命令标记 part** —— 前端靠它加「命令」标签
    expect(command).toBeDefined();
    const payload = command?.['data'] as { command?: string };
    expect(payload.command).toBe('help');
    // ⚠️ **零 token 消耗** —— 命令不产生任何模型调用
    expect(modelCalls).toBe(0);
  });

  it('⚠️ 未知命令 → 明确报错，**不发模型**', async () => {
    const sessionId = await createSession();
    modelCalls = 0;

    const { text } = await sendCommand(sessionId, '/unknowncmd');

    expect(text).toContain('未知命令');
    expect(text).toContain('/unknowncmd');
    expect(modelCalls).toBe(0);
  });

  it('/usage → 返回本月 token 与花费', async () => {
    const sessionId = await createSession();
    const { text } = await sendCommand(sessionId, '/usage');

    expect(text).toContain('本月用量');
    expect(text).toContain('token');
    expect(text).toContain('本会话');
  });

  it('/model → 列出可用模型', async () => {
    const sessionId = await createSession();
    const { text } = await sendCommand(sessionId, '/model');

    expect(text).toContain('可用模型');
    expect(text).toContain('fake-model');
  });

  it('/thinking → 开关思考模式', async () => {
    const sessionId = await createSession();
    const { text } = await sendCommand(sessionId, '/thinking off');

    expect(text).toContain('思考模式');
  });

  it('⚠️ 命令结果落库（刷新后还在）', async () => {
    const sessionId = await createSession();
    await sendCommand(sessionId, '/help');

    // 📌 **落库在流结束之后** —— 轮询等一下
    let messages: Array<{ role: string; content: string; parts: Array<{ type: string }> }> = [];
    for (let i = 0; i < 50; i += 1) {
      const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`);
      const body = (await response.json()) as { messages: typeof messages };
      messages = body.messages;
      if (messages.some((message) => message.role === 'assistant')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.content).toContain('/help');
    // 📌 **命令标记 part 也落库** —— 刷新后还认得出这是命令
    expect(assistant?.parts.some((part) => part.type === 'data-command')).toBe(true);
  });

  it('GET /api/v1/commands → 前端补全用的清单', async () => {
    const response = await fetch(`${baseUrl}/api/v1/commands`);
    const body = (await response.json()) as {
      commands: Array<{ name: string; usage: string; summary: string }>;
      skills: string[];
    };
    expect(body.commands.length).toBeGreaterThan(5);
    expect(body.commands.find((command) => command.name === 'help')?.usage).toBe('/help');
    expect(Array.isArray(body.skills)).toBe(true);
  });
});
