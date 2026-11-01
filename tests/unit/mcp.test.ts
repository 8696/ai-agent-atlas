import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  McpConfigError,
  loadMcpConfig,
  validateMcpServers,
} from '../../src/tools/mcp/config';
import { jsonSchemaToZod, toolInputSchema } from '../../src/tools/mcp/json-schema';
import { mcpToolDefinitions, mcpToolName } from '../../src/tools/mcp/tools';
import type { McpServerConfig } from '../../src/tools/mcp/config';

/**
 * MCP 接入的单元测试 —— **纯函数，不连真的 server**。
 *
 * 覆盖（[12-c C5](../../docs/12-c-需求-工具技能与扩展.md)）：
 * - 配置读不出来 / 格式不对 / server 名重复
 * - JSON Schema → zod 的结构映射
 * - 工具名加前缀 · 敏感档 · 白名单过滤 · 描述标来源
 */

/** 造一个临时配置文件 */
function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('MCP 配置', () => {
  it('文件不存在 → 当成「没配 MCP」（不是错误）', () => {
    expect(loadMcpConfig('/tmp/atlas-not-exists-mcp.json')).toEqual({ servers: [] });
  });

  it('⚠️ JSON 不合法 → 报错（不静默当成没配）', () => {
    const path = writeConfig('{ 这不是 JSON');
    expect(() => loadMcpConfig(path)).toThrow(McpConfigError);
  });

  it('⚠️ server 名重复 → 报错（工具名前缀会撞）', () => {
    const path = writeConfig(
      JSON.stringify({
        servers: [
          { name: 'a', transport: 'stdio', command: 'x' },
          { name: 'a', transport: 'stdio', command: 'y' },
        ],
      }),
    );
    expect(() => loadMcpConfig(path)).toThrow(McpConfigError);
  });

  it('默认值补齐：toolPolicy=ask · enabled=true', () => {
    const path = writeConfig(
      JSON.stringify({ servers: [{ name: 'demo', transport: 'stdio', command: 'echo' }] }),
    );
    const config = loadMcpConfig(path);
    expect(config.servers[0]?.toolPolicy).toBe('ask');
    expect(config.servers[0]?.enabled).toBe(true);
    expect(config.servers[0]?.args).toEqual([]);
  });

  it('自检：stdio 缺 command / http 缺 url 都要报出来', () => {
    const problems = validateMcpServers([
      { name: 'a', transport: 'stdio', args: [], env: {}, headers: {}, enabled: true, toolPolicy: 'ask' },
      { name: 'b', transport: 'http', args: [], env: {}, headers: {}, enabled: true, toolPolicy: 'ask' },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('command');
    expect(problems[1]).toContain('url');
  });

  it('停用的 server 不参与自检', () => {
    const problems = validateMcpServers([
      {
        name: 'a',
        transport: 'stdio',
        command: undefined,
        args: [],
        env: {},
        headers: {},
        enabled: false,
        toolPolicy: 'ask',
      },
    ]);
    expect(problems).toHaveLength(0);
  });
});

describe('JSON Schema → zod', () => {
  it('object：必填与可选分开', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
    expect(schema.safeParse({ a: 'x' }).success).toBe(true);
    expect(schema.safeParse({ b: 1 }).success).toBe(false);
  });

  it('enum → 字面量枚举', () => {
    const schema = jsonSchemaToZod({ type: 'string', enum: ['a', 'b'] });
    expect(schema.safeParse('a').success).toBe(true);
    expect(schema.safeParse('c').success).toBe(false);
  });

  it('array → 数组', () => {
    const schema = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(schema.safeParse(['a', 'b']).success).toBe(true);
    expect(schema.safeParse(['a', 1]).success).toBe(false);
  });

  it('integer → 整数', () => {
    const schema = jsonSchemaToZod({ type: 'integer' });
    expect(schema.safeParse(3).success).toBe(true);
    expect(schema.safeParse(3.5).success).toBe(false);
  });

  it('⚠️ 不认识的类型放宽（不猜）', () => {
    const schema = jsonSchemaToZod({ type: 'weird-thing' });
    expect(schema.safeParse({ anything: true }).success).toBe(true);
  });

  it('⚠️ 顶层不是 object → 包一层（工具入参必须是对象）', () => {
    const schema = toolInputSchema({ type: 'string' });
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('递归太深 → 放宽（防恶意 server）', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 30; i += 1) {
      node = { type: 'object', properties: { child: node } };
    }
    expect(() => jsonSchemaToZod(node)).not.toThrow();
  });
});

describe('MCP 工具定义', () => {
  const server: McpServerConfig = {
    name: 'demo',
    transport: 'stdio',
    command: 'echo',
    args: [],
    env: {},
    headers: {},
    enabled: true,
    toolPolicy: 'ask',
  };

  it('工具名带 server 前缀（避免撞名）', () => {
    expect(mcpToolName('demo', 'echo')).toBe('demo__echo');
  });

  it('工具名里的怪字符被换成下划线', () => {
    expect(mcpToolName('my server', 'a.b')).toBe('my_server__a_b');
  });

  it('⚠️ 敏感档一律 high（第三方来源默认高危）', () => {
    const tools = mcpToolDefinitions(
      server,
      [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }],
      { callTool: () => Promise.resolve({ text: 'ok', isError: false }) },
    );
    expect(tools[0]?.sensitivity).toBe('high');
    expect(tools[0]?.source).toBe('mcp');
  });

  it('描述里标了来源与「不可信数据」', () => {
    const tools = mcpToolDefinitions(
      server,
      [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }],
      { callTool: () => Promise.resolve({ text: 'ok', isError: false }) },
    );
    expect(tools[0]?.description).toContain('[来自 MCP: demo]');
    expect(tools[0]?.description).toContain('不可信数据');
  });

  it('⚠️ 白名单只放行一部分工具', () => {
    const tools = mcpToolDefinitions(
      { ...server, tools: ['echo'] },
      [
        { name: 'echo', description: '回显', inputSchema: { type: 'object' } },
        { name: 'danger', description: '危险', inputSchema: { type: 'object' } },
      ],
      { callTool: () => Promise.resolve({ text: 'ok', isError: false }) },
    );
    expect(tools.map((tool) => tool.name)).toEqual(['demo__echo']);
  });

  it('调用工具 → 结果回灌给模型', async () => {
    const callTool = vi.fn(() => Promise.resolve({ text: '回声', isError: false }));
    const tools = mcpToolDefinitions(
      server,
      [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }],
      { callTool },
    );
    const result = await tools[0]?.invoke({ text: 'hi' }, {});
    expect(callTool).toHaveBeenCalledWith('demo', 'echo', { text: 'hi' });
    expect(result?.ok).toBe(true);
    expect(result?.output).toContain('回声');
  });

  it('⚠️ 工具报错误 → 不算成功（原因要显示）', async () => {
    const tools = mcpToolDefinitions(
      server,
      [{ name: 'boom', description: '炸', inputSchema: { type: 'object' } }],
      { callTool: () => Promise.resolve({ text: '炸了', isError: true }) },
    );
    const result = await tools[0]?.invoke({}, {});
    expect(result?.ok).toBe(false);
    expect(result?.output).toContain('炸了');
  });

  it('⚠️ 连接断了 → 报错而不是静默返回空', async () => {
    const tools = mcpToolDefinitions(
      server,
      [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }],
      {
        callTool: () => Promise.reject(new Error('连不上')),
      },
    );
    const result = await tools[0]?.invoke({}, {});
    expect(result?.ok).toBe(false);
    expect(result?.output).toContain('连不上');
  });

  it('⚠️ 入参太大 → 拒绝（不让第三方 server 往上下文里塞超大字符串）', async () => {
    const callTool = vi.fn(() => Promise.resolve({ text: 'ok', isError: false }));
    const tools = mcpToolDefinitions(
      server,
      [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }],
      { callTool },
    );
    const result = await tools[0]?.invoke({ blob: 'x'.repeat(300_000) }, {});
    expect(result?.ok).toBe(false);
    expect(result?.output).toContain('参数太大');
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('MCP 策略查询', () => {
  it('⚠️ 改名后的工具名也能查到策略（`toolPolicy: auto` 别丢）', async () => {
    const { McpManager, stripMcpPrefix } = await import('../../src/tools/mcp/manager');
    const manager = new McpManager();
    manager.registerForTest(
      {
        name: 'demo',
        transport: 'stdio',
        command: 'echo',
        args: [],
        env: {},
        headers: {},
        enabled: true,
        toolPolicy: 'auto',
      },
      [{ name: 'demo__echo', tool: 'echo' }],
    );

    expect(manager.policyFor('demo__echo')).toBe('auto');
    // 📌 **注册表撞名时改名成 `mcp__<原名>`** —— 策略照样要查得到
    expect(manager.policyFor('mcp__demo__echo')).toBe('auto');
    expect(stripMcpPrefix('mcp__demo__echo')).toBe('demo__echo');
    // 📌 **不是 MCP 工具 → undefined**（权限闸会走后面的档位规则）
    expect(manager.policyFor('read_file')).toBeUndefined();
  });
});
