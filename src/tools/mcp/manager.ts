import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAudit } from '../../lib/audit.js';
import { logger } from '../../logger.js';
import { MCP_FILE_TEMPLATE } from '../../prompts/defaults.js';
import type { ToolGroup } from '../registry.js';
import type { ToolDefinition } from '../types.js';
import { McpConnection, McpConnectionError } from './client.js';
import {
  loadMcpConfig,
  mcpConfigPath,
  validateMcpServers,
  type McpConfig,
  type McpServerConfig,
} from './config.js';
import { mcpToolDefinitions, mcpToolName } from './tools.js';

/**
 * 配置文件不存在就建一个空的 —— **让人知道去哪儿改**。
 *
 * 📌 **空文件 = 没接任何 server** —— 是正常状态，不是错误。
 */
function ensureConfigFile(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, MCP_FILE_TEMPLATE, 'utf8');
  } catch (err) {
    logger.warn({ err, path }, 'MCP 配置文件建不出来 —— 不影响其它功能');
  }
}

/**
 * MCP 管理器 —— **连外部 server，把它们的工具并进工具池**
 * （见 [12-c C5](./docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **一个 server 挂掉不影响别的** ——
 * 连接失败只记日志 + 标记 `error`，工具池照常有其它工具。
 *
 * 📌 **重连走指数退避** —— server 刚起来时可能还没监听，
 * 立刻重连只会一直失败。
 */

/** server 的连接状态 */
export type McpServerStatus = 'connected' | 'error' | 'disabled';

/** 一个 server 的状态（**给启动日志与 `/mcp` 看的**） */
export interface McpServerState {
  /** server 名 */
  name: string;
  /** 传输方式 */
  transport: string;
  /** 状态 */
  status: McpServerStatus;
  /** 暴露出来的工具名 */
  tools: string[];
  /** 失败原因 */
  error?: string | undefined;
}

/** 重连退避上限（毫秒） */
const MAX_BACKOFF_MS = 30_000;

/** 管理器 */
export class McpManager {
  /** server 配置 */
  private configs = new Map<string, McpServerConfig>();

  /** 已建立的连接 */
  private connections = new Map<string, McpConnection>();

  /** 工具名 → 远端工具 */
  private routes = new Map<string, { server: string; tool: string }>();

  /** 工具定义 */
  private toolDefs: ToolDefinition[] = [];

  /** 状态 */
  private states = new Map<string, McpServerState>();

  /** 每个 server 的重连退避（毫秒） */
  private backoff = new Map<string, number>();

  /** 初始化过没有 */
  private initialized = false;

  /**
   * 初始化 —— **启动时调一次**。
   *
   * ⚠️ **配置坏了不拖垮服务** —— 记一条错误日志，MCP 当没配，
   *    其余功能照常（本地 Agent 的可用性比 MCP 更重要）。
   */
  async init(options: { path?: string } = {}): Promise<void> {
    const path = options.path ?? mcpConfigPath();
    ensureConfigFile(path);

    let config: McpConfig;
    try {
      config = loadMcpConfig(path);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'MCP 配置有问题 —— 本次不接 MCP（其余功能不受影响）',
      );
      this.initialized = true;
      return;
    }

    this.configs = new Map(config.servers.map((server) => [server.name, server]));
    this.connections.clear();
    this.routes.clear();
    this.toolDefs = [];
    this.states.clear();
    this.backoff.clear();

    // ⚠️ **先自检** —— 配置写错时日志里要能看到真正的原因
    const problems = validateMcpServers(config.servers);
    for (const problem of problems) {
      logger.error({ problem }, 'MCP 配置有问题');
    }
    const broken = new Set(
      problems.map((problem) => {
        const match = problem.match(/server「(.+?)」/);
        return match?.[1] ?? '';
      }),
    );

    for (const server of config.servers) {
      if (!server.enabled) {
        this.states.set(server.name, {
          name: server.name,
          transport: server.transport,
          status: 'disabled',
          tools: [],
        });
        continue;
      }
      if (broken.has(server.name)) {
        this.states.set(server.name, {
          name: server.name,
          transport: server.transport,
          status: 'error',
          tools: [],
          error: problems.find((item) => item.includes(`「${server.name}」`)) ?? '配置有问题',
        });
        continue;
      }
      await this.connectServer(server);
    }

    this.initialized = true;

    const connected = [...this.states.values()].filter((state) => state.status === 'connected');
    const failed = [...this.states.values()].filter((state) => state.status === 'error');
    logger.info(
      {
        servers: this.states.size,
        connected: connected.map((state) => state.name),
        failed: failed.map((state) => ({ name: state.name, error: state.error })),
        tools: this.toolDefs.map((tool) => tool.name),
      },
      'MCP 已接入',
    );

    // ⚠️ **MCP 工具默认每次确认** —— 没有 UI 能提示这件事，
    //    只能在启动日志里明确说一遍（见 [04-c §4.7](./docs/04-c-ui-配置入口.md)）
    if (this.toolDefs.length > 0) {
      const asking = connected.filter((state) => {
        const server = this.configs.get(state.name);
        return server?.toolPolicy === 'ask';
      });
      logger.info(
        { servers: asking.map((state) => state.name) },
        'MCP 工具默认 ask，每次调用都需要确认',
      );
    }
  }

  /** 连一个 server（**失败只标记，不抛**） */
  private async connectServer(server: McpServerConfig): Promise<void> {
    const connection = new McpConnection(server);
    try {
      await connection.connect();
      const descriptors = await connection.listTools();
      const tools = mcpToolDefinitions(server, descriptors, {
        callTool: (serverName, toolName, args) => this.callTool(serverName, toolName, args),
      });

      for (const tool of tools) {
        const descriptor = descriptors.find((item) => mcpToolName(server.name, item.name) === tool.name);
        if (!descriptor) continue;
        this.routes.set(tool.name, { server: server.name, tool: descriptor.name });
      }

      this.connections.set(server.name, connection);
      this.toolDefs.push(...tools);
      this.states.set(server.name, {
        name: server.name,
        transport: server.transport,
        status: 'connected',
        tools: tools.map((tool) => tool.name),
      });
      this.backoff.delete(server.name);

      logger.info(
        { server: server.name, tools: tools.map((tool) => tool.name) },
        'MCP server 已连接',
      );
      await writeAudit('MCP_CONNECTED', 'mcp', server.name, {
        name: server.name,
        transport: server.transport,
        tools: tools.map((tool) => tool.name),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await connection.close().catch(() => undefined);
      this.states.set(server.name, {
        name: server.name,
        transport: server.transport,
        status: 'error',
        tools: [],
        error: message,
      });
      logger.error({ server: server.name, err: message }, 'MCP server 连接失败 —— 其它工具不受影响');
    }
  }

  /** 工具组（**给注册表合并用**） */
  groups(): ToolGroup[] {
    if (this.toolDefs.length === 0) return [];
    return [{ source: 'mcp', tools: [...this.toolDefs] }];
  }

  /**
   * 工具的策略（**server 粒度**）。
   *
   * ⚠️ **默认 `ask`** —— 第三方来源一律要确认（见 [12-c C3](./docs/12-c-需求-工具技能与扩展.md)）。
   */
  policyFor(toolName: string): 'ask' | 'auto' | 'off' | undefined {
    const route = this.routes.get(toolName);
    if (!route) return undefined;
    const server = this.configs.get(route.server);
    return server?.toolPolicy;
  }

  /**
   * 调一个 MCP 工具。
   *
   * ⚠️ **断了先重连** —— server 可能只是重启了。
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
  ): Promise<{ text: string; isError: boolean }> {
    const connection = await this.ensureConnected(serverName);
    try {
      return await connection.callTool(toolName, args);
    } catch (err) {
      // ⚠️ **连接类错误要退避** —— 别把一个刚重启的 server 打死
      if (err instanceof McpConnectionError) this.markFailure(serverName);
      throw err;
    }
  }

  /** 拿到连接（**断了就按退避重连**） */
  private async ensureConnected(serverName: string): Promise<McpConnection> {
    const existing = this.connections.get(serverName);
    if (existing?.connected) return existing;

    const server = this.configs.get(serverName);
    if (!server) {
      throw new McpConnectionError(`没有这个 MCP server：${serverName}`, 'MCP_SERVER_UNKNOWN');
    }

    // ⚠️ **退避没到就不重连** —— 别把 server 打死
    const wait = this.backoff.get(serverName) ?? 0;
    if (wait > 0 && Date.now() < wait) {
      throw new McpConnectionError(
        `MCP server「${serverName}」暂时连不上（退避中）`,
        'MCP_SERVER_BACKOFF',
      );
    }

    await this.connectServer(server);
    const connection = this.connections.get(serverName);
    if (!connection) {
      const state = this.states.get(serverName);
      throw new McpConnectionError(
        `MCP server「${serverName}」连不上：${state?.error ?? '未知原因'}`,
        'MCP_CONNECT_FAILED',
      );
    }
    return connection;
  }

  /** 记一次失败（**退避翻倍**） */
  markFailure(serverName: string): void {
    const current = this.backoff.get(serverName) ?? 1000;
    const next = Math.min(current * 2, MAX_BACKOFF_MS);
    this.backoff.set(serverName, Date.now() + next);
  }

  /** 所有 server 的状态 */
  listStates(): McpServerState[] {
    return [...this.states.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 工具池指纹 —— **server 或工具变了就重建注册表**。
   */
  fingerprint(): string {
    if (!this.initialized) return 'uninitialized';
    return this.listStates()
      .map((state) => `${state.name}:${state.status}:${state.tools.join(',')}`)
      .join('|');
  }

  /** 断开所有连接（**关服务时调**） */
  async shutdown(): Promise<void> {
    for (const connection of this.connections.values()) {
      await connection.close().catch(() => undefined);
    }
    this.connections.clear();
  }
}

/** 进程内一份 */
let manager: McpManager | undefined;

/** 拿到管理器 */
export function getMcpManager(): McpManager {
  if (!manager) manager = new McpManager();
  return manager;
}

/** 初始化 MCP（**启动时调**） */
export async function initMcp(options: { path?: string } = {}): Promise<void> {
  await getMcpManager().init(options);
}

/** 工具组（**给注册表用**） */
export function mcpToolGroups(): ToolGroup[] {
  return getMcpManager().groups();
}

/**
 * 工具的策略查询（**给权限闸用**）。
 *
 * ⚠️ **返回 undefined = 不是 MCP 工具** —— 权限闸会走后面的档位规则。
 */
export function mcpPolicyLookup(toolName: string): 'ask' | 'auto' | 'off' | undefined {
  return getMcpManager().policyFor(toolName);
}

/** 状态（**给 `/mcp` 命令与启动日志用**） */
export function listMcpServers(): McpServerState[] {
  return getMcpManager().listStates();
}

/** 测试用：换掉管理器 */
export function setMcpManager(next: McpManager | undefined): void {
  manager = next;
}
