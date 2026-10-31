import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { McpServerConfig } from './config.js';

/**
 * MCP 客户端 —— **连一个外部 server，拿到它的工具**
 * （见 [12-c C5](./docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **第三方 server 是不可信来源** ——
 * 它的工具描述、工具名、返回内容全都当数据看，不当指令看。
 *
 * 📌 **只做两件事** —— 工具发现 + 工具调用。
 * 不实现 MCP 的 resources / prompts / sampling（本期不做）。
 */

/** MCP 工具的描述（**只取我们要的字段**） */
export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** 连接失败 */
export class McpConnectionError extends Error {
  readonly code: string;

  constructor(message: string, code = 'MCP_CONNECT_FAILED') {
    super(message);
    this.name = 'McpConnectionError';
    this.code = code;
  }
}

/** 一个 server 的连接 */
export class McpConnection {
  /** server 名 */
  readonly serverName: string;

  private readonly config: McpServerConfig;
  private client: Client | undefined;
  private transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | undefined;
  private closed = false;

  constructor(serverConfig: McpServerConfig) {
    this.config = serverConfig;
    this.serverName = serverConfig.name;
  }

  /** 连上了吗 */
  get connected(): boolean {
    return this.client !== undefined && !this.closed;
  }

  /**
   * 建立连接。
   *
   * ⚠️ **stdio 会真的拉起一个子进程** —— `command` / `args` 来自
   * `data/mcp.json`，那是用户自己写的配置（不是模型能改的内容）。
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const transport = this.buildTransport();
    const client = new Client(
      { name: 'atlas', version: '0.1.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, { timeout: this.timeoutMs });
    } catch (err) {
      await safeClose(client);
      throw new McpConnectionError(
        `连 MCP server「${this.serverName}」失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.client = client;
    this.transport = transport;
    this.closed = false;
  }

  /** 按传输方式建 transport */
  private buildTransport():
    | StdioClientTransport
    | SSEClientTransport
    | StreamableHTTPClientTransport {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new McpConnectionError(
          `MCP server「${this.serverName}」用的是 stdio，但没有 command`,
          'MCP_CONFIG_INVALID',
        );
      }
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        // ⚠️ **只透传 server 自己声明的环境变量** ——
        //    别的（比如模型 key）不该给第三方进程
        env: { ...this.config.env },
        stderr: 'pipe',
      });
    }

    if (!this.config.url) {
      throw new McpConnectionError(
        `MCP server「${this.serverName}」用的是 ${this.config.transport}，但没有 url`,
        'MCP_CONFIG_INVALID',
      );
    }

    let url: URL;
    try {
      url = new URL(this.config.url);
    } catch {
      throw new McpConnectionError(
        `MCP server「${this.serverName}」的 url 不合法：${this.config.url}`,
        'MCP_CONFIG_INVALID',
      );
    }

    const requestInit: RequestInit = { headers: { ...this.config.headers } };
    if (this.config.transport === 'sse') {
      return new SSEClientTransport(url, { requestInit });
    }
    return new StreamableHTTPClientTransport(url, { requestInit });
  }

  /** 单次调用超时 */
  private get timeoutMs(): number {
    return this.config.timeoutMs ?? config.TOOL_TIMEOUT_MS;
  }

  /**
   * 列出这个 server 的工具。
   *
   * ⚠️ **分页要拉完** —— 有的 server 一页只给 20 个工具。
   */
  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.client) {
      throw new McpConnectionError(`MCP server「${this.serverName}」还没连上`);
    }

    const out: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    // ⚠️ **最多翻 20 页** —— 防止有 server 无限翻页
    for (let page = 0; page < 20; page += 1) {
      const result = await this.client.listTools(
        cursor ? { cursor } : {},
        { timeout: this.timeoutMs },
      );
      for (const tool of result.tools) {
        out.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * 调一个工具。
   *
   * ⚠️ **返回值是不可信数据** —— 会被原样回灌给模型，
   *    所以外面一定要包「不可信数据」标记（见 `tools/output.ts`）。
   */
  async callTool(
    toolName: string,
    args: unknown,
  ): Promise<{ text: string; isError: boolean }> {
    if (!this.client) {
      throw new McpConnectionError(`MCP server「${this.serverName}」还没连上`);
    }

    const result = await this.client.callTool(
      {
        name: toolName,
        arguments: (args ?? {}) as Record<string, unknown>,
      },
      undefined,
      { timeout: this.timeoutMs },
    );

    const text = flattenContent(result.content);
    return { text, isError: result.isError === true };
  }

  /** 断开连接（**关掉子进程**） */
  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) await safeClose(client);
  }
}

/** MCP 的内容块 → 一段文本 */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { type?: string; text?: string; mimeType?: string; data?: string };
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
      continue;
    }
    if (record.type === 'image') {
      // 📌 **图片不塞进上下文** —— 只说清楚「有个图」，内容不进对话
      parts.push(`[图片 ${record.mimeType ?? '未知类型'}]`);
      continue;
    }
    if (record.type === 'resource' && record.text) {
      parts.push(record.text);
      continue;
    }
    parts.push(`[${record.type ?? '未知'} 类型的内容]`);
  }
  return parts.join('\n');
}

/** 关连接（**失败只记日志**） */
async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch (err) {
    logger.warn({ err }, '关闭 MCP 连接失败');
  }
}
