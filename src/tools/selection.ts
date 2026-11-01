import { config, type Env } from '../config.js';
import type { ToolDefinition } from './types.js';

/**
 * 工具池裁剪 —— **每轮按相关度打分，只给模型 top N**
 * （见 [12-c C1](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **不要硬编码阈值** —— 不同嵌入模型基线差很多，
 * 所以这里**只做相对排序**，不设「低于 X 分就不给」。
 *
 * 📌 **裁剪发生在调模型之前** —— 被裁掉的工具在这一轮里模型完全看不到。
 */

/**
 * 分词 —— **英文按词，中文按二元组**。
 *
 * ⚠️ **中文不按字切** —— 单字命中太多，噪声大；二元组（`目录`、`文件`）
 * 既能命中又不至于太泛。
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];

  // 英文 / 数字词
  for (const match of lowered.matchAll(/[a-z0-9_]{2,}/g)) {
    tokens.push(match[0]);
  }

  // 中文二元组
  const cjk = lowered.replace(/[^一-鿿]+/g, ' ');
  for (const run of cjk.split(' ')) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * 工具与问题的相关度（**0 ~ 1**）。
 *
 * 📌 **覆盖率口径** —— 问句里的词有多少能在工具名 + 描述里找到。
 * 工具名也算（模型常按名字找工具）。
 */
export function scoreTool(tool: ToolDefinition, query: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;

  const toolTokens = new Set(tokenize(`${tool.name} ${tool.description}`));
  let hit = 0;
  for (const token of queryTokens) {
    if (toolTokens.has(token)) hit += 1;
  }
  return hit / queryTokens.size;
}

/**
 * 一个关键词命中了吗。
 *
 * ⚠️ **ASCII 按词边界** —— `ls` 不该命中 `list`；
 *    中文按**子串**（「删除」能命中「把那条删掉」）。
 */
function keywordMatches(lowerQuery: string, keyword: string): boolean {
  const key = keyword.trim().toLowerCase();
  if (key === '') return false;
  if (/^[\x20-\x7e]+$/.test(key)) {
    const words: string[] = lowerQuery.match(/[a-z0-9_+#.-]+/g) ?? [];
    if (words.includes(key)) return true;
    // 📌 **带空格的短语**（如 `npm install`）走子串
    return key.includes(' ') && lowerQuery.includes(key);
  }
  return lowerQuery.includes(key);
}

/**
 * 这个工具是不是「用户这句话明确要用」的。
 *
 * ⚠️ **命中就强制保留** —— 不参与名额竞争
 *    （见 `tools/types.ts` 里 `keywords` 的注释：为什么高危工具不能靠相关度抢名额）。
 */
export function keywordHit(
  tool: { keywords?: string[] | undefined; keywordGroups?: string[][] | undefined },
  query: string,
): boolean {
  const lower = query.toLowerCase();
  if (tool.keywords?.some((keyword) => keywordMatches(lower, keyword))) return true;
  const groups = tool.keywordGroups ?? [];
  if (groups.length === 0) return false;
  // 📌 **每一组都要命中** —— 「删」+「文件」这种组合
  return groups.every((group) => group.some((keyword) => keywordMatches(lower, keyword)));
}

/**
 * 裁剪工具池。
 *
 * 📌 **总是保留 `low` / `normal` 档的基础工具** —— 它们是「顺手就能做的事」，
 * 砍掉会让 Agent 变笨；`high` 档按相关度取前几个。
 *
 * ⚠️ **命中关键词的工具强制保留** —— 相关度只是「猜」，
 * 关键词才是「用户明确说了要用它」。
 * 以前没有这一层时，**高危工具只剩一两个名额**，
 * 而中文打分噪声大 → 「跑一下测试」看不见 `shell`、
 * 「删除 data/tmp」看不见 `delete_path`（详见 `tools/types.ts`）。
 */
export function selectTools(
  tools: ToolDefinition[],
  query: string,
  env: Env = config,
): ToolDefinition[] {
  const limit = env.MAX_TOOLS_PER_TURN;

  // ── ① 命中关键词的：强制保留 ──
  const forced = tools.filter((tool) => keywordHit(tool, query));
  if (forced.length >= tools.length) return tools;
  const rest = tools.filter((tool) => !forced.some((item) => item.name === tool.name));
  // 📌 **强制保留的工具占名额** —— 但它们是用户明确要的，不该被挤掉
  const budget = Math.max(0, limit - forced.length);
  if (rest.length <= budget) return [...forced, ...rest];

  // ── ② 剩下的按相关度抢名额 ──
  const scored = rest
    .map((tool) => ({ tool, score: scoreTool(tool, query) }))
    .sort((a, b) => b.score - a.score);

  const basic = scored.filter((item) => item.tool.sensitivity !== 'high');
  const risky = scored.filter((item) => item.tool.sensitivity === 'high');

  // ⚠️ **基础工具也超上限时按相关度取前 N** —— 不硬编码阈值，只做相对排序
  if (basic.length >= budget) {
    // 📌 **但高危工具至少留一个** ——
    //    全砍掉的话，模型连「写文件」「跑命令」都看不见，
    //    验收项「工具池超过上限时，模型仍能选到最相关的那个」就不成立
    //    （见 [12-c C1](../docs/12-c-需求-工具技能与扩展.md)）
    const kept = basic.slice(0, Math.max(0, budget - 1)).map((item) => item.tool);
    const topRisky = risky[0]?.tool;
    return [...forced, ...kept, ...(topRisky ? [topRisky] : [])];
  }

  const picked = [
    ...basic.map((item) => item.tool),
    ...risky.slice(0, budget - basic.length).map((item) => item.tool),
  ];
  return [...forced, ...picked];
}
