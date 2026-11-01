import { config } from '../../config.js';
import { scoreRelevance } from '../../lib/text.js';
import { estimateTokens } from '../../lib/tokens.js';
import { readMemory } from './store.js';
import { MEMORY_FILES, type MemoryEntry, type MemoryFile } from './types.js';

/**
 * 记忆召回 —— **注入到系统提示词**（见 [12-d D2](../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **注入哪几条按「与当前问题相不相关」排** —— 不是固定顺序。
 * 📌 **相关性是主序**，优先级（来源 > 置信度 > 更新时间）是**兜底**。
 * ⚠️ **没有索引的记忆按 0 分算** —— 跟「有索引但不相关」同档，
 * 不会被「缺索引」饿死。
 */

/** 召回到的一条记忆 */
export interface MemoryPick {
  /** 来自哪个文件 */
  file: MemoryFile;
  /** 条目 */
  entry: MemoryEntry;
  /** 相关度（0~1） */
  score: number;
}

/** 来源优先级（**手动 > 自动** —— 人写的更可信） */
const SOURCE_RANK: Record<string, number> = { manual: 1, auto: 0 };

/**
 * 挑要注入的记忆。
 *
 * ⚠️ **归档的不召回** —— `archived` 是软删：文件里还看得见，但不进上下文。
 */
export function pickMemories(query: string): MemoryPick[] {
  const picks: MemoryPick[] = [];
  // ⚠️ **相关性排序可以关** —— `MEMORY_RELEVANCE_ENABLED=false` 时
  //    全部按 0 分算，排序只剩优先级（来源 > 置信度 > 更新时间）
  const useRelevance = config.MEMORY_RELEVANCE_ENABLED;

  for (const file of MEMORY_FILES) {
    const content = readMemory(file);
    for (const entry of content.entries) {
      if (entry.status !== 'active') continue;
      if (entry.body.trim() === '') continue;
      picks.push({
        file,
        entry,
        score: useRelevance ? scoreRelevance(query, [entry.name, entry.body]) : 0,
      });
    }
  }

  picks.sort((a, b) => {
    // ⚠️ **相关性是主序**
    if (b.score !== a.score) return b.score - a.score;
    // ⚠️ **优先级是兜底**：来源 > 置信度 > 更新时间
    const sourceDiff = (SOURCE_RANK[b.entry.source] ?? 0) - (SOURCE_RANK[a.entry.source] ?? 0);
    if (sourceDiff !== 0) return sourceDiff;
    if (b.entry.confidence !== a.entry.confidence) {
      return b.entry.confidence - a.entry.confidence;
    }
    return b.entry.updated.localeCompare(a.entry.updated);
  });

  return picks;
}

/**
 * 用量表头 —— **让模型知道自己记了多少、还剩多少**。
 *
 * 📌 **导出给工具与 `/memory` 命令用** —— 用户问「我记了多少」时，
 *    不用再让模型自己数文件。
 */
export function memoryUsageHeader(): string {
  const parts: string[] = [];
  for (const file of MEMORY_FILES) {
    const content = readMemory(file);
    const percent = Math.round((content.usedChars / Math.max(1, content.limit)) * 100);
    parts.push(`${file}.md ${content.usedChars} / ${content.limit} 字符（${percent}%）`);
  }
  return `记忆库已用：${parts.join(' · ')}`;
}

/**
 * 组装注入系统提示词的那段记忆。
 *
 * ⚠️ **双重裁剪**：条数（`MEMORY_TOP_K`）+ token 预算（`MEMORY_TOKEN_BUDGET`）。
 * 📌 **返回空串表示「没有可注入的记忆」** —— 调用方据此跳过这一段。
 */
export function buildMemorySection(query: string): string {
  if (!config.MEMORY_ENABLED) return '';

  const picks = pickMemories(query);
  if (picks.length === 0) return '';

  const topK = Math.max(1, config.MEMORY_TOP_K);
  const budget = Math.max(1, config.MEMORY_TOKEN_BUDGET);

  const chosen: MemoryPick[] = [];
  let used = 0;
  for (const pick of picks) {
    if (chosen.length >= topK) break;
    const cost = estimateTokens(`${pick.entry.name}\n${pick.entry.body}`);
    if (chosen.length > 0 && used + cost > budget) break;
    chosen.push(pick);
    used += cost;
  }

  if (chosen.length === 0) return '';

  const lines = chosen.map((pick) => {
    const { entry } = pick;
    const meta = [
      entry.kind,
      `置信度 ${entry.confidence}`,
      entry.updated || '未知日期',
      entry.source === 'manual' ? '手动' : '自动',
    ].join(' · ');
    return `- ${entry.name}（${meta}）：${entry.body}`;
  });

  return `${memoryUsageHeader()}\n${lines.join('\n')}`;
}
