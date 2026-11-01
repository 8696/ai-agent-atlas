import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  parseDuckDuckGoHtml,
  resolveSearchBackend,
} from '../../src/tools/builtin/search';
import type { Env } from '../../src/config/schema';

/**
 * 联网搜索后端的单元测试 —— **纯函数，不发请求**。
 *
 * 覆盖（[12-c C2](../../docs/12-c-需求-工具技能与扩展.md)）：
 * - 后端判定（`auto` 的顺序 · 显式指定）
 * - DuckDuckGo 的 HTML 解析（**免 key 兜底靠它**）
 */

/** 造一份 env（**只填用得到的字段**） */
function envOf(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe('搜索后端判定', () => {
  it('⚠️ 什么都没配 → duckduckgo（免 key，工具始终可用）', () => {
    const backend = resolveSearchBackend(
      envOf({ WEB_SEARCH_PROVIDER: 'auto', WEB_SEARCH_URL: undefined, WEB_SEARCH_API_KEY: undefined }),
    );
    expect(backend.provider).toBe('duckduckgo');
  });

  it('配了 URL → searxng', () => {
    const backend = resolveSearchBackend(
      envOf({
        WEB_SEARCH_PROVIDER: 'auto',
        WEB_SEARCH_URL: 'http://127.0.0.1:8888/search',
        WEB_SEARCH_API_KEY: undefined,
      }),
    );
    expect(backend.provider).toBe('searxng');
    expect(backend.url).toBe('http://127.0.0.1:8888/search');
  });

  it('只配了 Key → tavily', () => {
    const backend = resolveSearchBackend(
      envOf({
        WEB_SEARCH_PROVIDER: 'auto',
        WEB_SEARCH_URL: undefined,
        WEB_SEARCH_API_KEY: 'key-1',
      }),
    );
    expect(backend.provider).toBe('tavily');
  });

  it('显式指定优先', () => {
    const backend = resolveSearchBackend(
      envOf({
        WEB_SEARCH_PROVIDER: 'brave',
        WEB_SEARCH_URL: 'http://127.0.0.1:8888/search',
        WEB_SEARCH_API_KEY: undefined,
      }),
    );
    expect(backend.provider).toBe('brave');
  });
});

describe('DuckDuckGo HTML 解析', () => {
  const html = `
    <div class="result">
      <a rel="nofollow" class="result__a"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=xyz">示例 <b>标题</b></a>
      <a class="result__snippet" href="#">这是摘要 &amp; 说明</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a"
         href="https://example.org/b">第二个</a>
      <a class="result__snippet" href="#">第二个的摘要</a>
    </div>
  `;

  it('⚠️ 解析出标题 · 链接 · 摘要', () => {
    const hits = parseDuckDuckGoHtml(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBe('示例 标题');
    // 📌 **跳转链接要还原成真实地址**
    expect(hits[0]?.url).toBe('https://example.com/a');
    expect(hits[0]?.content).toBe('这是摘要 & 说明');
    expect(hits[1]?.url).toBe('https://example.org/b');
  });

  it('没有结果 → 空数组（不假装有结果）', () => {
    expect(parseDuckDuckGoHtml('<html><body>没有结果</body></html>')).toEqual([]);
  });
});

describe('HTML 实体', () => {
  it('常见实体能反转义', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39;')).toBe("a & b <c> 'd'");
  });
});
