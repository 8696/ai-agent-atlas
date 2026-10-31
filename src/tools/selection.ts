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
 * 裁剪工具池。
 *
 * 📌 **总是保留 `low` / `normal` 档的基础工具** —— 它们是「顺手就能做的事」，
 * 砍掉会让 Agent 变笨；`high` 档按相关度取前几个。
 */
export function selectTools(
  tools: ToolDefinition[],
  query: string,
  env: Env = config,
): ToolDefinition[] {
  const limit = env.MAX_TOOLS_PER_TURN;
  if (tools.length <= limit) return tools;

  const scored = tools
    .map((tool) => ({ tool, score: scoreTool(tool, query) }))
    .sort((a, b) => b.score - a.score);

  const basic = scored.filter((item) => item.tool.sensitivity !== 'high');
  const risky = scored.filter((item) => item.tool.sensitivity === 'high');

  // ⚠️ **基础工具也超上限时按相关度取前 N** —— 不硬编码阈值，只做相对排序
  if (basic.length >= limit) {
    return basic.slice(0, limit).map((item) => item.tool);
  }

  const picked = [...basic, ...risky.slice(0, limit - basic.length)];
  return picked.map((item) => item.tool);
}
