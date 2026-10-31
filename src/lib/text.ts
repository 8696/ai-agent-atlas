/**
 * 文本工具 —— **分词与相关度**（纯函数，不碰配置）。
 *
 * 📌 **为什么不用嵌入模型**：本项目的检索口径是 **FTS5 全文索引**，
 * 不用向量（见 [12-d D3](../docs/12-d-需求-记忆与配置.md)）。
 * 相关度只需要**相对排序**，不需要绝对分数。
 *
 * ⚠️ **不硬编码阈值** —— 不同语料的基线差很多，只做相对排序。
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
 * 相关度（**0 ~ 1**）—— 覆盖率口径。
 *
 * 📌 **问句里的词有多少能在目标文本里找到** —— 目标文本可以是多段
 * （工具名 + 描述、记忆的标题 + 正文）。
 */
export function scoreRelevance(query: string, targets: string[]): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;

  const targetTokens = new Set(tokenize(targets.join(' ')));
  if (targetTokens.size === 0) return 0;

  let hit = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) hit += 1;
  }
  return hit / queryTokens.size;
}

/**
 * 把文本展开成「二元组 + 空格」的形式 —— **让 2 字中文词也能被 trigram 搜到**。
 *
 * 📌 **为什么需要它**：
 * SQLite FTS5 的 `trigram` 分词器**按 3 个字符切**，
 * 所以「周报」这种 2 字词**没法作为查询短语**（不足 3 个字符 → 切不出 token）。
 * 展开之后，「周报」变成独立的一段，后面跟一个空格 → trigram 能切出 `周报 `。
 *
 * ⚠️ **索引侧与查询侧必须用同一个展开函数** —— 两边不一致就永远对不上。
 *
 * 📌 **英文词整体保留** —— 不切二元组（英文词的边界是空格）。
 */
export function expandForTrigram(text: string): string {
  const parts: string[] = [];

  // 英文 / 数字词（**整体保留**）
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_][a-z0-9_.-]*/g)) {
    parts.push(match[0]);
  }

  // 中文：切成二元组
  const runs = text.replace(/[^一-鿿]+/g, ' ').split(' ').filter(Boolean);
  for (const run of runs) {
    if (run.length === 1) {
      parts.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      parts.push(run.slice(i, i + 2));
    }
  }

  // ⚠️ **末尾补一个空格** —— 最后一段也要有后继空格，否则它的 trigram 切不出来
  return `${parts.join(' ')} `;
}

/**
 * 从查询里取出用于 FTS5 的短语。
 *
 * 📌 **每个短语后面都带一个空格** —— trigram 至少要 3 个字符，
 * 二元组（2 字）+ 空格正好 3 个。
 *
 * ⚠️ **不要写死条数上限** —— 这里的 `limit` 只是防止超长查询把 FTS5 撑爆，
 * 真正的相关性由 bm25 排序决定（见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
 */
export function trigramPhrases(text: string, limit = 24): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const part of expandForTrigram(text).split(' ')) {
    if (part === '') continue;
    const phrase = `${part} `;
    // ⚠️ **不足 3 个字符的切掉** —— 单个汉字 + 空格只有 2 个字符
    if (phrase.length < 3) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
    if (phrases.length >= limit) break;
  }
  return phrases;
}
