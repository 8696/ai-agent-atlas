import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 三种来源的工具在**同一池**里（见 [12-c C1](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 覆盖：
 * - 内置 + Skill + MCP 三个工具**同时**出现在一轮给模型的工具清单里
 * - 名字冲突 → 改名或拒绝注册（不静默覆盖）
 */

/** 模型每一轮看到的工具名 */
let offered: string[] = [];

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
        bindTools: (tools: Array<{ name?: string }>) => {
          offered = tools.map((tool) => tool.name ?? '');
          return model;
        },
        stream: async function* () {
          yield { text: '好的' };
        },
        invoke: async () => ({ content: '' }),
      };
      return model;
    },
  };
});

useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');
const { setToolRegistry, buildRegistry, mergeToolGroups } = await import(
  '../../src/tools/registry'
);

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

/** 造一个工具 */
function fake(name: string, source: 'builtin' | 'skill' | 'mcp') {
  return {
    name,
    description: `${source} 的 ${name}`,
    schema: z.object({ value: z.string().optional() }),
    sensitivity: 'normal' as const,
    source,
    enabled: true,
    executor: 'local' as const,
    invoke: () => Promise.resolve({ ok: true, output: '好了' }),
  };
}

describe('工具池的三个来源', () => {
  it('📌 内置 + Skill + MCP → 一轮里模型全都能看到', async () => {
    const builtin = fake('builtin_tool', 'builtin');
    const skill = fake('skill_tool', 'skill');
    const mcp = fake('mcp_tool', 'mcp');
    const registry = buildRegistry([
      { source: 'builtin', tools: [builtin] },
      { source: 'skill', tools: [skill] },
      { source: 'mcp', tools: [mcp] },
    ]);
    setToolRegistry(registry);
    offered = [];

    const sessionResponse = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
    const session = (await sessionResponse.json()) as { id: string };

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '干活' }] }],
      }),
    });
    const reader = response.body?.getReader();
    while (reader) {
      const { done } = await reader.read();
      if (done) break;
    }

    // 📌 **三个都在这一轮的工具清单里** —— 模型想调哪个调哪个
    expect(offered).toContain('builtin_tool');
    expect(offered).toContain('skill_tool');
    expect(offered).toContain('mcp_tool');
  });

  it('⚠️ 名字冲突 → 改名注册（不静默覆盖）', () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [fake('dup', 'builtin')] },
      { source: 'skill', tools: [fake('dup', 'skill')] },
    ]);
    const names = merged.map((tool) => tool.name);
    expect(names).toContain('dup');
    expect(names).toContain('skill__dup');
  });

  it('⚠️ 两个内置撞名 → 直接抛（启动失败，不静默覆盖）', () => {
    expect(() =>
      mergeToolGroups([
        { source: 'builtin', tools: [fake('dup', 'builtin')] },
        { source: 'builtin', tools: [fake('dup', 'builtin')] },
      ]),
    ).toThrow(/重名/);
  });
});
