import { z } from 'zod';
import { config } from '../../config.js';
import { EgressError, guardedFetch } from '../../lib/security/egress.js';
import { parseArgs, schemas } from '../args.js';
import { truncateOutput } from '../output.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * 网络工具 —— `http_request` / `web_fetch` / `web_search`
 * （见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **只允许 http / https** —— `file://` / `gopher://` 一律拒。
 * ⚠️ **出网校验逐跳做** —— 只校验第一跳 = 换个 `Location` 就出去了。
 */

/** 正文大小上限（**别把一个大文件读进上下文**） */
const MAX_BODY_BYTES = 512 * 1024;

/** 出错 → 失败结果（**不抛异常** —— 异常在包装层转成错误文本） */
function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof EgressError ? error.code : 'TOOL_FAILED';
  return { ok: false, output: `请求失败：${message}`, error: `${code}: ${message}` };
}

/** `http_request` —— 发 HTTP 请求 */
const httpRequestSchema = z.object({
  url: z.string().min(1).max(4000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
  headers: z.record(z.string(), z.string().max(2000)).optional(),
  body: schemas.text(100_000).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

export const httpRequestTool: ToolDefinition = {
  name: 'http_request',
  description:
    '发一个 HTTP / HTTPS 请求（只支持这两种协议）。' +
    '内网地址、回环地址、云元数据地址会被拒绝；重定向每一跳都会重新校验。' +
    '返回状态码、响应头与正文（正文过长会截断）。',
  schema: httpRequestSchema,
  sensitivity: 'normal',
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  async invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(httpRequestSchema, args);
      const response = await guardedFetch(input.url, {
        allowPrivate: config.ALLOW_PRIVATE_EGRESS,
        timeoutMs: input.timeoutMs ?? config.TOOL_TIMEOUT_MS,
        maxBytes: MAX_BODY_BYTES,
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(input.body ? { body: input.body } : {}),
      });

      const clipped = truncateOutput(response.body);
      const header = `状态码：${response.status}\n最终地址：${response.finalUrl}\n`;
      return {
        ok: response.status >= 200 && response.status < 400,
        output: `${header}${clipped.text}`,
        error: response.status >= 400 ? `HTTP_${response.status}` : undefined,
        data: { status: response.status, finalUrl: response.finalUrl },
        truncated: clipped.truncated,
        originalLength: clipped.originalLength,
      };
    } catch (err) {
      return fail(err);
    }
  },
};

/**
 * HTML → 纯文本（**够用就好** —— 不引 HTML 解析依赖）。
 *
 * ⚠️ **先删 script / style** —— 里面的内容对模型没用，还可能被当成指令。
 */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');

  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
  };
  let text = withoutCode;
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }
  text = text.replace(/&#(\d+);/g, (_match, code: string) =>
    String.fromCodePoint(Number(code)),
  );
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** `web_fetch` —— 抓网页转纯文本 */
const webFetchSchema = z.object({
  url: z.string().min(1).max(4000),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    '抓一个网页并转成纯文本（去掉标签、脚本与样式）。' +
    '只支持 http / https；内网与云元数据地址会被拒绝。',
  schema: webFetchSchema,
  sensitivity: 'normal',
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  async invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(webFetchSchema, args);
      const response = await guardedFetch(input.url, {
        allowPrivate: config.ALLOW_PRIVATE_EGRESS,
        timeoutMs: input.timeoutMs ?? config.TOOL_TIMEOUT_MS,
        maxBytes: MAX_BODY_BYTES,
        headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' },
      });
      const text = htmlToText(response.body);
      const clipped = truncateOutput(text);
      return {
        ok: response.status >= 200 && response.status < 400,
        output: `来源：${response.finalUrl}\n${clipped.text}`,
        error: response.status >= 400 ? `HTTP_${response.status}` : undefined,
        data: { status: response.status, finalUrl: response.finalUrl },
        truncated: clipped.truncated,
        originalLength: clipped.originalLength,
      };
    } catch (err) {
      return fail(err);
    }
  },
};

/** 网络工具（**`http_request` 与 `web_fetch`**） */
export function httpTools(): ToolDefinition[] {
  return [httpRequestTool, webFetchTool];
}
