import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../../config.js';
import { resolvePath } from '../../config/paths.js';

/**
 * MCP server 配置 —— **列表型配置放文件，不放 `.env`**
 * （见 [12-c C5](./docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ```json
 * {
 *   "servers": [
 *     {
 *       "name": "example",
 *       "transport": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@example/mcp"],
 *       "enabled": true,
 *       "toolPolicy": "ask"
 *     }
 *   ]
 * }
 * ```
 *
 * ⚠️ **`.env` 里只留 `MCP_CONFIG_PATH` 一个路径** —— `.env` 全是标量，
 * 塞 JSON 进去迟早出事（见 [12-a A4](./docs/12-a-需求-应用外壳与上下文.md)）。
 */

/** 传输方式 */
export const MCP_TRANSPORTS = ['stdio', 'sse', 'http'] as const;

/** 工具策略（**server 粒度**） */
export const MCP_TOOL_POLICIES = ['ask', 'auto', 'off'] as const;

/** 一个 MCP server 的配置 */
export const McpServerSchema = z.object({
  /** server 名 —— **工具名前缀用它**（`<server>__<tool>`） */
  name: z.string().min(1).max(64),
  /** 传输方式 */
  transport: z.enum(MCP_TRANSPORTS).default('stdio'),
  /** stdio：启动的命令 */
  command: z.string().min(1).max(1024).optional(),
  /** stdio：命令参数 */
  args: z.array(z.string().max(1024)).max(50).default([]),
  /** stdio：额外环境变量 */
  env: z.record(z.string(), z.string().max(4096)).default({}),
  /** sse / http：地址 */
  url: z.string().max(2048).optional(),
  /** sse / http：请求头（如 `Authorization`） */
  headers: z.record(z.string(), z.string().max(4096)).default({}),
  /** 是否启用 */
  enabled: z.boolean().default(true),
  /**
   * 工具策略（**第三方来源一律当高危**）：
   * - `ask`（默认）—— 每个工具都要人确认
   * - `auto` —— 自动放行（**用户显式选择**）
   * - `off` —— 整个 server 的工具都不给用
   */
  toolPolicy: z.enum(MCP_TOOL_POLICIES).default('ask'),
  /**
   * 工具白名单（**可选**）——
   * 第三方 server 往往带几十个工具，全塞进池子会淹掉模型。
   * 不填 = 全部暴露。
   */
  tools: z.array(z.string().min(1).max(200)).max(200).optional(),
  /** 单次调用的超时（毫秒）—— 不填用全局 `TOOL_TIMEOUT_MS` */
  timeoutMs: z.coerce.number().int().positive().max(300_000).optional(),
});

/** 一个 MCP server 的配置（解析后） */
export type McpServerConfig = z.infer<typeof McpServerSchema>;

/** 整个配置文件 */
export const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).max(20).default([]),
});

/** 整个配置文件（解析后） */
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** 配置文件的绝对路径 */
export function mcpConfigPath(): string {
  return resolvePath(config.MCP_CONFIG_PATH);
}

/** 配置文件读不出来 / 格式不对 */
export class McpConfigError extends Error {
  readonly code: string;

  constructor(message: string, code = 'MCP_CONFIG_INVALID') {
    super(message);
    this.name = 'McpConfigError';
    this.code = code;
  }
}

/**
 * 读 MCP 配置。
 *
 * ⚠️ **文件不存在 = 没配 MCP** —— 这是正常状态，不是错误。
 * ⚠️ **文件存在但格式不对 → 抛错** —— 拼错了要让人知道，
 *    静默当成「没配」会让人以为 MCP 接上了。
 */
export function loadMcpConfig(path: string = mcpConfigPath()): McpConfig {
  if (!existsSync(path)) return { servers: [] };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new McpConfigError(
      `MCP 配置读不出来（${path}）：${err instanceof Error ? err.message : String(err)}`,
      'MCP_CONFIG_UNREADABLE',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new McpConfigError(
      `MCP 配置不是合法 JSON（${path}）：${err instanceof Error ? err.message : String(err)}`,
      'MCP_CONFIG_INVALID_JSON',
    );
  }

  const result = McpConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
      .join('；');
    throw new McpConfigError(`MCP 配置有错（${path}）：${detail}`);
  }

  // ⚠️ **server 名必须唯一** —— 工具名前缀靠它，撞名会让两个 server 的工具混在一起
  const seen = new Set<string>();
  for (const server of result.data.servers) {
    if (seen.has(server.name)) {
      throw new McpConfigError(`MCP 配置有错：server 名「${server.name}」重复了`);
    }
    seen.add(server.name);
  }

  return result.data;
}

/**
 * 配置自检 —— **传输方式与必填字段对不上就报错**。
 *
 * ⚠️ **在连之前查** —— 不然连接失败时日志里是一堆网络错误，
 *    真正的原因（stdio 少了 `command`）反而看不见。
 */
export function validateMcpServers(servers: McpServerConfig[]): string[] {
  const problems: string[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    if (server.transport === 'stdio') {
      if (!server.command) {
        problems.push(`server「${server.name}」用的是 stdio，但没有 command`);
      }
    } else if (!server.url) {
      problems.push(`server「${server.name}」用的是 ${server.transport}，但没有 url`);
    }
  }
  return problems;
}
