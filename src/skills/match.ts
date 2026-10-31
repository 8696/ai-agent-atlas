import { config } from '../config.js';
import { logger } from '../logger.js';
import { ensureFtsTables, probeFts, searchSkills } from '../lib/fts.js';
import { scoreRelevance } from '../lib/text.js';
import { getSkills } from './store.js';
import type { Skill } from './types.js';

/**
 * 技能匹配 —— **FTS5 全文检索，不用向量**
 * （见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **拿用户的问句去搜技能的 `name` + `description` + 正文摘要**，
 * 按 FTS5 排名取 top N。
 *
 * ⚠️ **相似度阈值不写死** —— 不同分词器基线差很多 → **只做相对排序**。
 * ⚠️ **中文靠 trigram** —— SQLite 默认的 `unicode61` 不切中文（见 `lib/fts.ts`）。
 *
 * 📌 **FTS5 不可用 → 退回覆盖率打分** —— 功能少一半但**不影响对话**。
 */

/** 一条命中 */
export interface SkillHit {
  /** 命中的技能 */
  skill: Skill;
  /** 相关度（**越大越相关**） */
  score: number;
}

/** 降级路径：覆盖率打分 */
function coverageMatch(skills: Skill[], query: string, limit: number): SkillHit[] {
  return skills
    .map((skill) => ({
      skill,
      score: scoreRelevance(query, [
        skill.meta.name,
        skill.meta.description,
        skill.body.slice(0, 500),
      ]),
    }))
    // ⚠️ **零命中不注入** —— 完全不相关的技能塞进上下文只是噪音
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 匹配技能。
 *
 * @param query 用户的问题（**整句** —— 检索侧会自己抽词）
 * @param options.limit 最多取几条（默认 `SKILL_TOP_K`）
 */
export async function matchSkills(
  query: string,
  options: { limit?: number } = {},
): Promise<SkillHit[]> {
  const limit = Math.max(1, options.limit ?? config.SKILL_TOP_K);
  const skills = getSkills().filter((skill) => skill.meta.enabled);
  if (skills.length === 0) return [];
  if (!query.trim()) return [];

  const probe = await probeFts();
  if (!probe.available) {
    logger.warn({ reason: probe.reason }, 'FTS5 不可用 —— 技能匹配退回覆盖率打分');
    return coverageMatch(skills, query, limit);
  }

  try {
    await ensureFtsTables();
    // 📌 **多取一些再按名字过滤** —— 索引里可能有已停用的技能
    const hits = await searchSkills(query, limit * 3);
    if (hits.length === 0) return [];

    const byName = new Map(skills.map((skill) => [skill.meta.name, skill]));
    const matched: SkillHit[] = [];
    for (const hit of hits) {
      const skill = byName.get(hit.name);
      if (!skill) continue;
      // ⚠️ **bm25 越小越相关** —— 取负号让「越大越相关」，与降级路径口径一致
      matched.push({ skill, score: -hit.score });
      if (matched.length >= limit) break;
    }
    return matched;
  } catch (err) {
    logger.warn({ err }, '技能检索失败 —— 退回覆盖率打分');
    return coverageMatch(skills, query, limit);
  }
}
