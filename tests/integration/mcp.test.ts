import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `invoke` 是 async —— **签名要求它返回 Promise**，
 * 它只造一个返回值、没有 await。
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { initMcp, listMcpServers, setMcpManager } = await import('../../src/tools/mcp/manager');
const { getToolRegistry, setToolRegistry } = await import('../../src/tools/registry');

/**
 * MCP 接入的集成测试 —— **真进程 · 真 stdio 传输**。
 *
 * 覆盖（[12-c C5](../../docs/12-c-需求-工具技能与扩展.md) 的验收项）：
 * - 配置里加一个 server → 工具出现在工具池
 * - 该工具能被调用（结果正确）
 * - MCP 工具默认弹确认（`toolPolicy=ask`）
 * - 能按白名单只暴露一部分工具
 * - server 起不来 → 状态是 error，其它工具不受影响
 */

/** tsx 的可执行文件（**不依赖 ATLAS_HOME**） */
const TSX_BIN = join(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'tsx');

/** 假的 MCP server 脚本 */
const SERVER_SCRIPT = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');

/** 写一份 MCP 配置 */
function writeConfig(servers: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-cfg-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({ servers }), 'utf8');
  return path;
}

/** 一个能跑起来的 stdio server 配置 */
function demoServer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo',
    transport: 'stdio',
    command: TSX_BIN,
    args: [SERVER_SCRIPT],
    enabled: true,
    toolPolicy: 'ask',
    ...extra,
  };
}

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
});

afterAll(async () => {
  setToolRegistry(undefined);
  setMcpManager(undefined);
});

describe('MCP 接入', () => {
  it('⚠️ 配置里加一个 server → 重启后工具出现在工具池', async () => {
    const path = writeConfig([demoServer()]);
    await initMcp({ path });

    const states = listMcpServers();
    expect(states).toHaveLength(1);
    expect(states[0]?.status).toBe('connected');
    expect(states[0]?.tools).toContain('demo__echo');

    const registry = getToolRegistry();
    expect(registry.get('demo__echo')).toBeDefined();
    expect(registry.get('demo__add')).toBeDefined();
  });

  it('⚠️ MCP 工具默认弹确认（toolPolicy=ask）', async () => {
    const path = writeConfig([demoServer()]);
    await initMcp({ path });

    const { decideTool } = await import('../../src/lib/security/policy');
    const { mcpPolicyLookup } = await import('../../src/tools/mcp/manager');
    const tool = getToolRegistry().get('demo__echo');
    expect(tool).toBeDefined();

    const decision = decideTool(
      { name: 'demo__echo', sensitivity: tool?.sensitivity ?? 'high', source: 'mcp' },
      { mcpPolicy: mcpPolicyLookup },
    );
    expect(decision.decision).toBe('await');
  });

  it('该工具能被调用（结果回灌）', async () => {
    const path = writeConfig([demoServer()]);
    await initMcp({ path });

    const tool = getToolRegistry().get('demo__echo');
    expect(tool).toBeDefined();
    const result = await tool?.invoke({ text: '你好' }, {});
    expect(result?.ok).toBe(true);
    expect(result?.output).toContain('你好');
  });

  it('工具报错误 → 不算成功', async () => {
    const path = writeConfig([demoServer()]);
    await initMcp({ path });

    const tool = getToolRegistry().get('demo__boom');
    const result = await tool?.invoke({}, {});
    expect(result?.ok).toBe(false);
  });

  it('⚠️ 能按白名单只暴露 server 的一部分工具', async () => {
    const path = writeConfig([demoServer({ tools: ['echo'] })]);
    await initMcp({ path });

    const registry = getToolRegistry();
    expect(registry.get('demo__echo')).toBeDefined();
    expect(registry.get('demo__add')).toBeUndefined();
  });

  it('⚠️ server 起不来 → 状态是 error，不影响其它工具', async () => {
    const path = writeConfig([
      demoServer({ name: 'broken', command: '/definitely/not/a/real/binary' }),
      demoServer({ name: 'good' }),
    ]);
    await initMcp({ path });

    const states = listMcpServers();
    const broken = states.find((state) => state.name === 'broken');
    const good = states.find((state) => state.name === 'good');
    expect(broken?.status).toBe('error');
    expect(broken?.error).toBeTruthy();
    expect(good?.status).toBe('connected');

    // ⚠️ **好的那个照常能调** —— 一个 server 挂掉不影响别人
    const registry = getToolRegistry();
    expect(registry.get('good__echo')).toBeDefined();
    const result = await registry.get('good__echo')?.invoke({ text: '还在' }, {});
    expect(result?.output).toContain('还在');
  });

  it('⚠️ 配置坏了 → 不接 MCP，但工具池照常有内置工具', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-bad-'));
    const path = join(dir, 'mcp.json');
    writeFileSync(path, '{ 这不是 JSON', 'utf8');

    await initMcp({ path });
    const registry = getToolRegistry();
    expect(registry.get('read_file')).toBeDefined();
    expect(registry.get('demo__echo')).toBeUndefined();
  });

  it('没配 MCP → 工具池里没有 MCP 工具，也不报错', async () => {
    await initMcp({ path: join(tmpdir(), 'atlas-no-such-mcp.json') });
    const registry = getToolRegistry();
    expect(registry.get('read_file')).toBeDefined();
    expect(registry.names().filter((name) => name.includes('__'))).toHaveLength(0);
  });
});
