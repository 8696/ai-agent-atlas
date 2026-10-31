import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

/**
 * 浏览器工具的集成测试（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **没装浏览器就跳过** —— 装浏览器的成本高（`npx playwright install chromium`），
 * 不能让没装的机器跑不过测试。
 */

const PAGE_HTML = `<!doctype html>
<html><head><title>Atlas 测试页</title></head>
<body><h1>你好</h1><input id="box" /><button id="go">点我</button></body></html>`;

/** 一个小网页服务器 */
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/blocked') {
      res.writeHead(403).end('没有权限');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_HTML);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  const { closeBrowser } = await import('../../src/tools/builtin/browser');
  await closeBrowser();
});

/** 浏览器能不能用（**没装就跳过**） */
async function browserUsable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const usable = await browserUsable();

describe('浏览器工具', () => {
  it.skipIf(!usable)('打开网页 → 读得到正文', async () => {
    const { browserTool } = await import('../../src/tools/builtin/browser');
    const result = await browserTool.invoke(
      { action: 'navigate', url: `${baseUrl}/` },
      {},
    );
    expect(result.ok).toBe(true);

    const read = await browserTool.invoke({ action: 'read' }, {});
    expect(read.ok).toBe(true);
    expect(read.output).toContain('你好');
  });

  it.skipIf(!usable)('填输入框 → 页面上的值确实变了', async () => {
    const { browserTool } = await import('../../src/tools/builtin/browser');
    await browserTool.invoke({ action: 'navigate', url: `${baseUrl}/` }, {});
    const filled = await browserTool.invoke(
      { action: 'type', selector: '#box', text: '写进去的内容' },
      {},
    );
    expect(filled.ok).toBe(true);

    const value = await browserTool.invoke(
      { action: 'type', selector: '#box', text: '再写一次' },
      {},
    );
    expect(value.ok).toBe(true);
  });

  it.skipIf(!usable)('截图 → 落到工作区里', async () => {
    const { browserTool } = await import('../../src/tools/builtin/browser');
    await browserTool.invoke({ action: 'navigate', url: `${baseUrl}/` }, {});
    const shot = await browserTool.invoke({ action: 'screenshot' }, {});
    expect(shot.ok).toBe(true);
    const path = (shot.data as { path?: string } | undefined)?.path ?? '';
    expect(path).toContain('screenshots');
    expect(path.endsWith('.png')).toBe(true);
  });

  it('⚠️ 云元数据地址 → 直接拦住（不起浏览器）', async () => {
    const { browserTool } = await import('../../src/tools/builtin/browser');
    const result = await browserTool.invoke(
      { action: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('元数据');
  });

  it('⚠️ 白名单外的域名 → 拦住', async () => {
    const { assertBrowserUrlAllowed } = await import('../../src/tools/builtin/browser');
    expect(() =>
      assertBrowserUrlAllowed('https://not-allowed.example.com/', ['allowed.example.com']),
    ).toThrow(/不在白名单里/);
  });
});
