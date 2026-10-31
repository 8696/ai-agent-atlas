import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 上下文注入的集成测试（见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 覆盖：
 * - 📌 **`AGENTS.md`（项目指令）进了系统提示词**
 * - 📌 **长期记忆进了系统提示词**
 * - 📌 **`{{agents}}` 占位符被替换**（不是原样留着）
 */

// ⚠️ **静音日志**
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 每次模型调用看到的系统提示词 */
let systemPrompts: string[] = [];

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
          const first = messages[0];
          systemPrompts.push(typeof first?.content === 'string' ? first.content : '');
          yield { text: '好的' };
        },
        invoke: async () => ({ content: '' }),
      };
      return model;
    },
  };
});

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
const home = useTempDatabase();

/** 📌 **项目指令文件** —— 写进临时项目根 */
const AGENTS_MARKER = '项目专用指令标记XYZ：回答时先说「遵命」。';
writeFileSync(join(home, 'AGENTS.md'), `# 项目指令\n\n${AGENTS_MARKER}\n`, 'utf8');

/** 📌 **长期记忆条目** —— 用记忆服务自己的 API 写（格式它认） */
const MEMORY_MARKER = '记忆专用标记ABC：用户 prefers pnpm';

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');
const { upsertMemoryEntry } = await import('../../src/services/memory/store');

upsertMemoryEntry('USER', {
  name: 'prefers-pnpm',
  kind: 'preference',
  confidence: 0.9,
  source: 'manual',
  updated: '2026-10-31',
  status: 'active',
  body: MEMORY_MARKER,
});

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

beforeEach(() => {
  systemPrompts = [];
});

/** 建一个会话 */
async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** 发一轮对话（**读完流**） */
async function chat(sessionId: string, text: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe('上下文注入（[12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）', () => {
  it('📌 `AGENTS.md` 的内容进了系统提示词', async () => {
    const sessionId = await createSession();
    await chat(sessionId, '你好');

    expect(systemPrompts.length).toBeGreaterThanOrEqual(1);
    expect(systemPrompts[0]).toContain(AGENTS_MARKER);
  });

  it('📌 `{{agents}}` 占位符被替换掉了（不是原样留着）', async () => {
    const sessionId = await createSession();
    await chat(sessionId, '你好');

    expect(systemPrompts[0]).not.toContain('{{agents}}');
    expect(systemPrompts[0]).toContain('项目指令（AGENTS.md）');
  });

  it('📌 长期记忆也进了系统提示词', async () => {
    const sessionId = await createSession();
    await chat(sessionId, '我 prefers 什么');

    expect(systemPrompts[0]).toContain(MEMORY_MARKER);
  });
});
