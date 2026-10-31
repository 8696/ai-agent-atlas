/**
 * 长期记忆的条目形态 —— **两个 Markdown 文件、结构化条目**
 * （见 [12-d D2](../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **不用自由格式散文** —— 结构化条目才能被 FTS5 索引、
 * 才能被程序增删改、才能算「已用多少字符」。
 */

/** 记忆文件（`data/memory/` 下两个） */
export type MemoryFile = 'MEMORY' | 'USER';

/** 条目类型 */
export type MemoryKind = 'fact' | 'context' | 'preference' | 'profile';

/** 条目来源（`auto` = 模型抽的 · `manual` = 人写的） */
export type MemorySource = 'auto' | 'manual';

/** 条目状态（`archived` = 软删：不再召回，但文件里还看得见） */
export type MemoryStatus = 'active' | 'archived';

/** 一条记忆 */
export interface MemoryEntry {
  /** 标题（**kebab-case** —— 同一个文件里唯一） */
  name: string;
  /** 类型 */
  kind: MemoryKind;
  /** 置信度（0~1） */
  confidence: number;
  /** 来源 */
  source: MemorySource;
  /** 更新时间（`YYYY-MM-DD`） */
  updated: string;
  /** 状态 */
  status: MemoryStatus;
  /** 正文（**一句话能说完** —— 太长就拆成多条） */
  body: string;
}

/** 一个记忆文件的全部内容 */
export interface MemoryFileContent {
  /** 哪个文件 */
  file: MemoryFile;
  /** 绝对路径 */
  path: string;
  /** 文件头（**第一个 `## ` 之前的全部内容** —— 用户改过就保留） */
  header: string;
  /** 条目 */
  entries: MemoryEntry[];
  /** 原始内容 */
  raw: string;
  /** 已用字符数（**按整个文件算** —— 含文件头） */
  usedChars: number;
  /** 字符上限 */
  limit: number;
  /** 超限了 */
  overLimit: boolean;
}

/** 记忆的分类（**两个文件分别对应两个文件的条目**） */
export const MEMORY_FILES: MemoryFile[] = ['MEMORY', 'USER'];

/** 合法条目类型 */
export const MEMORY_KINDS: MemoryKind[] = ['fact', 'context', 'preference', 'profile'];

/** 条目标题的合法格式（**kebab-case** —— 改名/引用都要靠它） */
export const MEMORY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 条目名合法吗 */
export function isValidMemoryName(name: string): boolean {
  return MEMORY_NAME_PATTERN.test(name.trim());
}
