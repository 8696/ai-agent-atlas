import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { config, paths } from '../../config.js';
import { logger } from '../../logger.js';
import { classifyEndpointHost } from '../../lib/security/model-endpoint.js';
import { parseArgs, schemas } from '../args.js';
import { truncateOutput } from '../output.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * `browser` —— **浏览器自动化**（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 动作集只有五个：**navigate / click / type / read / screenshot** ——
 * 不做 DOM 级操作（那是另一档工作量）。
 *
 * ⚠️ **默认要人确认**（`high` 档）—— 浏览器能点能填，等于替用户操作账号。
 * ⚠️ **域名白名单**（`.env` 的 `BROWSER_ALLOWED_DOMAINS`）——
 * 留空 = 不限域名（但云元数据 / 链路本地地址照样禁）；
 * 填了之后只有名单里的域名能访问，**重定向与子资源也一样**（逐个请求拦）。
 */

/** Playwright 装了吗（**没装就不注册这个工具**） */
function playwrightAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

/** 动作 */
const browserSchema = z.object({
  /** 要做什么 */
  action: z.enum(['navigate', 'click', 'type', 'read', 'screenshot']),
  /** 目标网址（`navigate` 必填） */
  url: schemas.text(4096).optional(),
  /** 元素选择器（`click` / `type` 必填） */
  selector: schemas.text(1024).optional(),
  /** 要输入的文本（`type` 必填） */
  text: schemas.text(10_000).optional(),
  /** 超时（毫秒，默认 30 秒） */
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

/** 默认超时 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 解析白名单（**逗号分隔**） */
export function parseAllowedDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
}

/**
 * 这个域名在白名单里吗。
 *
 * 📌 **`*.example.com` 认「example.com」本身与它的子域**。
 */
export function domainAllowed(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === pattern;
  });
}

/** 校验一个网址能不能访问 */
export function assertBrowserUrlAllowed(
  rawUrl: string,
  allowlist: string[] = parseAllowedDomains(config.BROWSER_ALLOWED_DOMAINS),
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`网址解析不了：${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http / https（不支持 ${url.protocol}）`);
  }
  // ⚠️ **云元数据 / 链路本地一律禁** —— 浏览器能带 cookie 去访问
  if (classifyEndpointHost(url.hostname) === 'blocked') {
    throw new Error(`拒绝访问「${url.hostname}」—— 不能指向云元数据 / 链路本地地址`);
  }
  if (allowlist.length > 0 && !domainAllowed(url.hostname, allowlist)) {
    throw new Error(
      `域名「${url.hostname}」不在白名单里（白名单：${allowlist.join('、')}）—— 改白名单或换个网址`,
    );
  }
  return url;
}

/** 浏览器实例（**进程内复用** —— 每次新起一个太慢） */
let browserInstance: unknown = null;
/** 浏览器上下文 */
let contextInstance: unknown = null;
/** 当前页面 */
let pageInstance: unknown = null;

/** 关掉浏览器（**进程退出时**） */
export async function closeBrowser(): Promise<void> {
  const browser = browserInstance as { close?: () => Promise<void> } | null;
  browserInstance = null;
  contextInstance = null;
  pageInstance = null;
  if (browser?.close) {
    await browser.close().catch(() => {});
  }
}

/** 拿到可用的页面（**没有就起一个**） */
async function ensurePage(): Promise<{
  page: {
    goto: (url: string, options: unknown) => Promise<unknown>;
    click: (selector: string, options: unknown) => Promise<void>;
    fill: (selector: string, text: string, options: unknown) => Promise<void>;
    innerText: (selector: string) => Promise<string>;
    title: () => Promise<string>;
    url: () => string;
    screenshot: (options: unknown) => Promise<Buffer>;
    close: () => Promise<void>;
  };
  context: { route: (pattern: string, handler: unknown) => Promise<void> };
}> {
  const playwright = (await import('playwright')) as unknown as {
    chromium: {
      launch: (options: unknown) => Promise<unknown>;
      newContext: (options: unknown) => Promise<unknown>;
    };
  };

  if (!browserInstance) {
    browserInstance = await playwright.chromium.launch({ headless: true });
    logger.info('浏览器已启动');
  }
  const browser = browserInstance as {
    newContext: (options: unknown) => Promise<unknown>;
  };

  if (!contextInstance) {
    contextInstance = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      // ⚠️ **不持久化** —— 每次都是干净的会话，Cookie 不落盘
    });
    const context = contextInstance as {
      route: (pattern: string, handler: unknown) => Promise<void>;
    };
    // 📌 **每个请求都过一遍白名单** —— 重定向、子资源一样拦
    await context.route('**/*', async (route: {
      request: () => { url: () => string };
      continue: () => Promise<void>;
      abort: (reason: string) => Promise<void>;
    }) => {
      const url = route.request().url();
      try {
        assertBrowserUrlAllowed(url);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
  }

  const context = contextInstance as {
    newPage: () => Promise<unknown>;
  };
  if (!pageInstance) {
    pageInstance = await context.newPage();
  }
  return {
    page: pageInstance as never,
    context: contextInstance as never,
  };
}

/** 工具定义（**Playwright 没装就不注册**） */
export const browserTool: ToolDefinition = {
  name: 'browser',
  description:
    '用无头浏览器打开网页并操作它。支持五个动作：' +
    'navigate（打开网址）/ click（点元素）/ type（填输入框）/ read（读页面正文）/ screenshot（截图）。' +
    '打开网页能拿到 JavaScript 渲染后的内容，读不到就先用 navigate。',
  schema: browserSchema,
  sensitivity: 'high',
  riskNote: '会启动无头浏览器访问网页并操作页面 —— 点击与输入都算实际操作。',
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  async invoke(args: unknown): Promise<ToolResult> {
    const input = parseArgs(browserSchema, args);
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const { page } = await ensurePage();

      switch (input.action) {
        case 'navigate': {
          if (!input.url) return { ok: false, output: 'navigate 动作需要 url 参数' };
          const url = assertBrowserUrlAllowed(input.url);
          await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout });
          const title = await page.title();
          return {
            ok: true,
            output: `已打开 ${page.url()}\n标题：${title}`,
            data: { url: page.url(), title },
          };
        }

        case 'click': {
          if (!input.selector) return { ok: false, output: 'click 动作需要 selector 参数' };
          await page.click(input.selector, { timeout });
          return { ok: true, output: `已点击「${input.selector}」`, data: { selector: input.selector } };
        }

        case 'type': {
          if (!input.selector) return { ok: false, output: 'type 动作需要 selector 参数' };
          if (input.text === undefined) return { ok: false, output: 'type 动作需要 text 参数' };
          await page.fill(input.selector, input.text, { timeout });
          return {
            ok: true,
            output: `已在「${input.selector}」填入 ${input.text.length} 个字符`,
            data: { selector: input.selector, length: input.text.length },
          };
        }

        case 'read': {
          const text = await page.innerText('body');
          const clipped = truncateOutput(text);
          return {
            ok: true,
            output: clipped.text || '（页面正文是空的）',
            data: { url: page.url(), length: text.length },
            ...(clipped.truncated ? { truncated: true, originalLength: clipped.originalLength } : {}),
          };
        }

        case 'screenshot': {
          const dir = join(paths.data, 'screenshots');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `shot-${nanoid(8)}.png`);
          const buffer = await page.screenshot({ fullPage: false });
          // 📌 **写文件用同步 API** —— 少一个 import
          const { writeFileSync } = await import('node:fs');
          writeFileSync(file, buffer);
          return {
            ok: true,
            output: `已截图：${file}（${page.url()}）`,
            data: { path: file, url: page.url() },
          };
        }

        default:
          return { ok: false, output: `不认识的动作：${String(input.action)}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `浏览器操作失败：${message}`, error: message };
    }
  },
};

/** 浏览器工具组（**没装 Playwright 就不进池子**） */
export function browserToolGroups(): Array<{ source: 'builtin'; tools: ToolDefinition[] }> {
  if (!config.BROWSER_ENABLED) {
    logger.info('浏览器能力已关闭（BROWSER_ENABLED=false）');
    return [];
  }
  if (!playwrightAvailable()) {
    logger.warn('没装 Playwright —— browser 工具不注册（装完重启即可）');
    return [];
  }
  return [{ source: 'builtin', tools: [browserTool] }];
}
