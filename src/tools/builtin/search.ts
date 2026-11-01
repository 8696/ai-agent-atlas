import { z } from 'zod';
import { config } from '../../config.js';
import { EgressError, guardedFetch } from '../../lib/security/egress.js';
import { parseArgs, schemas } from '../args.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * 联网搜索 —— **多后端 + 免 key 兜底**
 * （见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **以前「没配后端就不注册这个工具」** ——
 *    而绝大多数人手上**没有 SearXNG**，
 *    于是「联网搜索」这个能力**等于没有**（模型根本看不见 `web_search`）。
 *
 * 📌 **现在的四种后端**：
 *
 * | provider     | 需要什么            | 说明                       |
 * | ------------ | ------------------- | -------------------------- |
 * | `searxng`    | `WEB_SEARCH_URL`    | 自建 SearXNG（原方案）     |
 * | `tavily`     | `WEB_SEARCH_API_KEY`| 商业 API，JSON 响应        |
 * | `brave`      | `WEB_SEARCH_API_KEY`| 商业 API，JSON 响应        |
 * | `duckduckgo` | **什么都不用**      | 免 key 兜底 · 抓 HTML      |
 *
 * 📌 **`auto` 的判定**：配了 URL 用 searxng；配了 Key 用 tavily；
 *    都没配 → **duckduckgo** —— 所以这个工具**始终可用**。
 */

/** 后端类型 */
export type SearchProvider = 'searxng' | 'tavily' | 'brave' | 'duckduckgo';

/** 一个搜索后端的配置 */
export interface SearchBackend {
  /** 后端类型 */
  provider: SearchProvider;
  /** SearXNG 的地址 */
  url?: string | undefined;
  /** 商业 API 的 Key */
  apiKey?: string | undefined;
}

/**
 * 决定用哪个搜索后端（**第一个**）。
 *
 * 📌 **`auto` 的判定顺序**：URL → Key → 免 key 兜底。
 */
export function resolveSearchBackend(env = config): SearchBackend {
  return resolveSearchBackends(env)[0] as SearchBackend;
}

/**
 * 搜索后端的**降级链**（按顺序试）。
 *
 * 📌 **为什么要链** —— 单个后端会挂：自建的 SearXNG 停了、
 *    商业 API 的 key 过期了、DuckDuckGo 改了页面结构。
 *    一次失败就整个搜索不可用，体验很差。
 *
 * 📌 **兜底永远是 DuckDuckGo** —— 免 key、不用配，至少能搜
 */
export function resolveSearchBackends(env = config): SearchBackend[] {
  const chain: SearchBackend[] = [];
  const push = (backend: SearchBackend): void => {
    if (!chain.some((item) => item.provider === backend.provider)) chain.push(backend);
  };

  const explicit = env.WEB_SEARCH_PROVIDER;
  if (explicit === 'searxng') push({ provider: 'searxng', url: env.WEB_SEARCH_URL });
  else if (explicit === 'tavily') push({ provider: 'tavily', apiKey: env.WEB_SEARCH_API_KEY });
  else if (explicit === 'brave') push({ provider: 'brave', apiKey: env.WEB_SEARCH_API_KEY });
  else if (explicit === 'duckduckgo') push({ provider: 'duckduckgo' });
  else {
    // ── auto ──
    if (env.WEB_SEARCH_URL) push({ provider: 'searxng', url: env.WEB_SEARCH_URL });
    if (env.WEB_SEARCH_API_KEY) push({ provider: 'tavily', apiKey: env.WEB_SEARCH_API_KEY });
  }

  // 📌 **兜底** —— 免 key 的 DuckDuckGo
  push({ provider: 'duckduckgo' });
  return chain;
}

/** 一条搜索结果 */
export interface SearchHit {
  /** 标题 */
  title: string;
  /** 链接 */
  url: string;
  /** 摘要 */
  content: string;
}

/** `web_search` 的入参 */
const webSearchSchema = z.object({
  query: schemas.text(500),
  limit: z.number().int().min(1).max(20).optional(),
});

/** 正文大小上限 */
const MAX_BODY_BYTES = 512 * 1024;

/** 失败 → 结果（**不抛异常** —— 异常在包装层转成错误文本） */
function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof EgressError ? error.code : 'TOOL_FAILED';
  return { ok: false, output: `搜索失败：${message}`, error: `${code}: ${message}` };
}

/** HTML 实体反转义（**够用就好** —— 搜索结果里的标题与摘要） */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  let out = text;
  for (const [entity, char] of Object.entries(named)) {
    out = out.split(entity).join(char);
  }
  return out.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

/** 去掉标签 */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 DuckDuckGo 的 HTML 结果页 —— **免 key 的兜底后端**。
 *
 * 📌 **DuckDuckGo 的链接是跳转链接** —— `//duckduckgo.com/l/?uddg=<编码后的真实地址>`，
 *    要把 `uddg` 解出来才是真实地址。
 */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const links: Array<{ href: string; title: string }> = [];
  const linkPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = linkPattern.exec(html);
  while (match !== null) {
    const href = match[1] ?? '';
    const title = stripTags(match[2] ?? '');
    if (title) links.push({ href, title });
    match = linkPattern.exec(html);
  }

  const snippets: string[] = [];
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let snippetMatch = snippetPattern.exec(html);
  while (snippetMatch !== null) {
    snippets.push(stripTags(snippetMatch[1] ?? ''));
    snippetMatch = snippetPattern.exec(html);
  }

  return links.slice(0, 20).map((link, index) => ({
    title: link.title,
    url: realUrlOf(link.href),
    content: snippets[index] ?? '',
  }));
}

/** 把 DuckDuckGo 的跳转链接还原成真实地址 */
function realUrlOf(href: string): string {
  const raw = href.startsWith('//') ? `https:${href}` : href;
  try {
    const url = new URL(raw);
    const target = url.searchParams.get('uddg');
    return target ?? raw;
  } catch {
    return raw;
  }
}

/** SearXNG 的返回形状 */
interface SearxngHit {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

/** Tavily 的返回形状 */
interface TavilyHit {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

/** Brave 的返回形状 */
interface BraveHit {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

/** 走 SearXNG */
async function searchSearxng(
  backend: SearchBackend,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const url = new URL(backend.url ?? '');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const response = await guardedFetch(url.toString(), {
    allowPrivate: config.ALLOW_PRIVATE_EGRESS,
    timeoutMs: config.TOOL_TIMEOUT_MS,
    maxBytes: MAX_BODY_BYTES,
    headers: { accept: 'application/json' },
  });
  if (response.status >= 400) {
    throw new Error(`搜索后端返回 ${response.status}`);
  }
  const parsed = JSON.parse(response.body) as { results?: SearxngHit[] };
  const hits = Array.isArray(parsed.results) ? parsed.results : [];
  return hits.slice(0, limit).map((hit) => ({
    title: typeof hit.title === 'string' ? hit.title : '(无标题)',
    url: typeof hit.url === 'string' ? hit.url : '',
    content: typeof hit.content === 'string' ? hit.content.replace(/\s+/g, ' ').slice(0, 300) : '',
  }));
}

/** 走 Tavily */
async function searchTavily(
  backend: SearchBackend,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const response = await guardedFetch('https://api.tavily.com/search', {
    allowPrivate: config.ALLOW_PRIVATE_EGRESS,
    timeoutMs: config.TOOL_TIMEOUT_MS,
    maxBytes: MAX_BODY_BYTES,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: backend.apiKey ?? '',
      query,
      max_results: limit,
    }),
  });
  if (response.status >= 400) {
    throw new Error(`Tavily 返回 ${response.status}`);
  }
  const parsed = JSON.parse(response.body) as { results?: TavilyHit[] };
  const hits = Array.isArray(parsed.results) ? parsed.results : [];
  return hits.slice(0, limit).map((hit) => ({
    title: typeof hit.title === 'string' ? hit.title : '(无标题)',
    url: typeof hit.url === 'string' ? hit.url : '',
    content: typeof hit.content === 'string' ? hit.content.replace(/\s+/g, ' ').slice(0, 300) : '',
  }));
}

/** 走 Brave */
async function searchBrave(
  backend: SearchBackend,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));

  const response = await guardedFetch(url.toString(), {
    allowPrivate: config.ALLOW_PRIVATE_EGRESS,
    timeoutMs: config.TOOL_TIMEOUT_MS,
    maxBytes: MAX_BODY_BYTES,
    headers: {
      accept: 'application/json',
      'x-subscription-token': backend.apiKey ?? '',
    },
  });
  if (response.status >= 400) {
    throw new Error(`Brave 返回 ${response.status}`);
  }
  const parsed = JSON.parse(response.body) as { web?: { results?: BraveHit[] } };
  const hits = Array.isArray(parsed.web?.results) ? parsed.web.results : [];
  return hits.slice(0, limit).map((hit) => ({
    title: typeof hit.title === 'string' ? hit.title : '(无标题)',
    url: typeof hit.url === 'string' ? hit.url : '',
    content:
      typeof hit.description === 'string' ? hit.description.replace(/\s+/g, ' ').slice(0, 300) : '',
  }));
}

/** 走 DuckDuckGo（**免 key**） */
async function searchDuckDuckGo(query: string, limit: number): Promise<SearchHit[]> {
  const response = await guardedFetch('https://html.duckduckgo.com/html/', {
    allowPrivate: config.ALLOW_PRIVATE_EGRESS,
    timeoutMs: config.TOOL_TIMEOUT_MS,
    maxBytes: MAX_BODY_BYTES,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (compatible; AtlasAgent/1.0)',
    },
    body: `q=${encodeURIComponent(query)}`,
  });
  if (response.status >= 400) {
    throw new Error(`DuckDuckGo 返回 ${response.status}`);
  }
  const hits = parseDuckDuckGoHtml(response.body);
  if (hits.length === 0) {
    throw new Error(
      'DuckDuckGo 没返回可解析的结果（页面结构变了或被限流）—— ' +
        '可以在 .env 里配 WEB_SEARCH_URL（SearXNG）或 WEB_SEARCH_API_KEY（Tavily / Brave）',
    );
  }
  return hits.slice(0, limit);
}

/** 按后端分派（**单个后端**） */
async function runOne(
  backend: SearchBackend,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  switch (backend.provider) {
    case 'searxng':
      return searchSearxng(backend, query, limit);
    case 'tavily':
      return searchTavily(backend, query, limit);
    case 'brave':
      return searchBrave(backend, query, limit);
    case 'duckduckgo':
      return searchDuckDuckGo(query, limit);
    default:
      throw new Error(`不认识的搜索后端：${String(backend.provider)}`);
  }
}

/** 搜索结果（**带上是哪个后端出的**） */
export interface SearchOutcome {
  /** 命中 */
  hits: SearchHit[];
  /** 实际用的后端 */
  backend: SearchProvider;
}

/**
 * 按降级链依次试 —— **一个挂了就试下一个**。
 *
 * ⚠️ **全都失败才报错** —— 报错里带上每个后端各自的原因
 */
export async function runSearch(
  backends: SearchBackend[],
  query: string,
  limit: number,
): Promise<SearchOutcome> {
  const errors: string[] = [];
  for (const backend of backends) {
    try {
      const hits = await runOne(backend, query, limit);
      return { hits, backend: backend.provider };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${backend.provider}：${message}`);
    }
  }
  throw new Error(`所有搜索后端都失败了 —— ${errors.join('；')}`);
}

/**
 * 联网搜索工具。
 *
 * 📌 **始终注册** —— 默认走免 key 的 DuckDuckGo；
 *    配了 SearXNG / Tavily / Brave 就走那个。
 */
export function createWebSearchTool(backends: SearchBackend[]): ToolDefinition {
  const names = backends.map((backend) => backend.provider).join(' → ');
  return {
    name: 'web_search',
    description:
      '联网搜索。返回一个标题 + 链接 + 摘要的列表。' +
      '适合查「最新消息」「某个库怎么用」这类需要外部信息的问题。' +
      `（后端：${names}；前一个失败会自动试下一个）`,
    schema: webSearchSchema,
    sensitivity: 'normal',
    keywords: ['搜一下', '搜索', '查一下', '最新', '新闻', '资料', 'search', '查询'],
    source: 'builtin',
    enabled: true,
    executor: 'subagent',
    async invoke(args: unknown): Promise<ToolResult> {
      try {
        const input = parseArgs(webSearchSchema, args);
        const limit = input.limit ?? 5;
        const outcome = await runSearch(backends, input.query, limit);
        const hits = outcome.hits;

        const lines = hits.map((hit, index) => {
          const snippet = hit.content.replace(/\s+/g, ' ').slice(0, 300);
          return `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${snippet}`;
        });

        return {
          ok: true,
          output:
            `搜索「${input.query}」的结果（后端：${outcome.backend}）：\n` +
            `${lines.join('\n') || '（没有结果）'}`,
          data: {
            query: input.query,
            count: lines.length,
            backend: outcome.backend,
            results: hits.map((hit) => ({ title: hit.title, url: hit.url })),
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  };
}

/** 搜索工具组（**始终可用** —— 降级链的最后一个是免 key 的 DuckDuckGo） */
export function searchTools(
  backends: SearchBackend[] = resolveSearchBackends(),
): Array<{ source: 'builtin'; tools: ToolDefinition[] }> {
  return [{ source: 'builtin', tools: [createWebSearchTool(backends)] }];
}
