import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { DIRS } from '../../config/paths.js';
import { writeAudit } from '../../lib/audit.js';
import { logger } from '../../logger.js';
import { ensureFtsTables, reindexMemory } from '../../lib/fts.js';
import {
  isValidMemoryName,
  MEMORY_FILES,
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryFile,
  type MemoryFileContent,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
} from './types.js';

/**
 * 长期记忆的读写 —— **两个 Markdown 文件**（见 [12-d D2](../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **人能直接读懂、能直接改** —— 这是对齐 Hermes 的关键取舍：
 * 记忆不藏在向量库里，就在两个 `.md` 文件里。
 *
 * ⚠️ **写入流程必须是「重读 → 合并 → 原子写」**：
 * - **重读** —— 抽取是 fire-and-forget，可能和用户手动编辑撞车
 * - **原子写** —— 写临时文件再 `rename`；原地覆盖失败会留下半个文件，
 *   记忆文件损坏 = 用户全部记忆丢失
 */

/** 记忆文件的绝对路径 */
export function memoryPath(file: MemoryFile): string {
  return join(DIRS.memory, `${file}.md`);
}

/** 字符上限（**两个文件不同** —— 对齐 Hermes 的 2200 / 1375） */
export function memoryLimit(file: MemoryFile): number {
  return file === 'MEMORY' ? config.MEMORY_MAX_CHARS : config.USER_MAX_CHARS;
}

/** 一条解析出来的条目 */
interface ParsedSection {
  heading: string;
  lines: string[];
}

/**
 * 按 `## ` 切段。
 *
 * ⚠️ **围栏代码块里的 `##` 不算标题** ——
 * 用户可能在文件里贴着「条目格式」示例（围起来的），
 * 不处理的话那个示例会被当成一条真的记忆。
 */
function splitSections(raw: string): { header: string; sections: ParsedSection[] } {
  const lines = raw.split('\n');
  const header: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | undefined;
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
    }
    const headingMatch = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch?.[1]) {
      current = { heading: headingMatch[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }

  return { header: header.join('\n'), sections };
}

/** 从条目正文里读出 `- key: value` 形式的元信息 */
function parseMeta(lines: string[]): {
  meta: Record<string, string>;
  body: string;
} {
  const meta: Record<string, string> = {};
  const bodyLines: string[] = [];
  let inMeta = true;

  for (const line of lines) {
    if (inMeta) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const match = /^-\s*([a-z_]+)\s*:\s*(.*)$/.exec(trimmed);
      if (match?.[1]) {
        // ⚠️ **去掉行尾注释** —— 用户常写成 `- kind: fact          # fact | context`
        const value = (match[2] ?? '').replace(/\s+#.*$/, '').trim();
        meta[match[1]] = value;
        continue;
      }
      inMeta = false;
    }
    bodyLines.push(line);
  }

  return { meta, body: bodyLines.join('\n').trim() };
}

function toKind(value: string | undefined): MemoryKind {
  const found = MEMORY_KINDS.find((kind) => kind === value);
  return found ?? 'fact';
}

function toSource(value: string | undefined): MemorySource {
  return value === 'manual' ? 'manual' : 'auto';
}

function toStatus(value: string | undefined): MemoryStatus {
  return value === 'archived' ? 'archived' : 'active';
}

function toConfidence(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.8;
  return Math.min(1, Math.max(0, parsed));
}

/** 解析一个记忆文件 */
export function parseMemoryFile(raw: string): { header: string; entries: MemoryEntry[] } {
  const { header, sections } = splitSections(raw);
  const entries: MemoryEntry[] = [];

  for (const section of sections) {
    const name = section.heading.trim();
    // ⚠️ **占位符标题不算条目** —— 用户贴的示例常是 `## <一句话标题>`
    if (!name || name.startsWith('<')) continue;
    const { meta, body } = parseMeta(section.lines);
    entries.push({
      name,
      kind: toKind(meta['kind']),
      confidence: toConfidence(meta['confidence']),
      source: toSource(meta['source']),
      updated: meta['updated'] ?? '',
      status: toStatus(meta['status']),
      body,
    });
  }

  return { header, entries };
}

/** 渲染一条条目 */
export function renderMemoryEntry(entry: MemoryEntry): string {
  return [
    `## ${entry.name}`,
    '',
    `- kind: ${entry.kind}`,
    `- confidence: ${entry.confidence}`,
    `- source: ${entry.source}`,
    `- updated: ${entry.updated}`,
    `- status: ${entry.status}`,
    '',
    entry.body,
    '',
  ].join('\n');
}

/** 渲染整个文件（**文件头原样保留** —— 用户改过就留着） */
export function renderMemoryFile(header: string, entries: MemoryEntry[]): string {
  const head = header.trim();
  const body = entries.map((entry) => renderMemoryEntry(entry).trimEnd()).join('\n\n');
  return `${head}${head ? '\n\n' : ''}${body}${body ? '\n' : ''}`;
}

/** 读一个记忆文件（**不存在就当空** —— 启动时会补模板） */
export function readMemory(file: MemoryFile): MemoryFileContent {
  const path = memoryPath(file);
  let raw = '';
  if (existsSync(path)) {
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      raw = '';
    }
  }
  const { header, entries } = parseMemoryFile(raw);
  const limit = memoryLimit(file);
  return {
    file,
    path,
    header,
    entries,
    raw,
    usedChars: raw.length,
    limit,
    overLimit: raw.length > limit,
  };
}

/**
 * 重建记忆的**检索索引**（**记忆在文件里 —— 改了就得重建**）。
 *
 * ⚠️ **失败不影响写盘** —— 索引只是检索用的，坏了也只是搜不到。
 */
export async function syncMemoryIndex(): Promise<void> {
  try {
    await ensureFtsTables();
    const entries: Array<{ file: string; name: string; body: string }> = [];
    for (const file of MEMORY_FILES) {
      for (const entry of readMemory(file).entries) {
        entries.push({ file, name: entry.name, body: entry.body });
      }
    }
    await reindexMemory(entries);
    indexedMtimes.clear();
    for (const file of MEMORY_FILES) {
      indexedMtimes.set(file, memoryFileMtime(file));
    }
  } catch (err) {
    logger.warn({ err }, '重建记忆索引失败 —— 只影响检索，不影响记忆本身');
  }
}

/**
 * 索引时各记忆文件的 mtime（**用来判断「文件被手改过」**）。
 *
 * ⚠️ **文件是真相** —— 人手改 `data/memory/USER.md` 之后，
 * 索引要跟着走（不然搜到的还是旧内容）
 * （见 [12-d D3](../docs/12-d-需求-记忆与配置.md)）。
 */
const indexedMtimes = new Map<string, number>();

/** 记忆文件的 mtime（**读不到就当 0**） */
function memoryFileMtime(file: string): number {
  try {
    return statSync(join(DIRS.memory, `${file}.md`)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * **索引是不是过期了** —— 有人手改过记忆文件就是过期。
 */
export function memoryIndexIsStale(): boolean {
  for (const file of MEMORY_FILES) {
    if (indexedMtimes.get(file) !== memoryFileMtime(file)) return true;
  }
  return false;
}

/**
 * **索引过期就重建** —— 检索之前调一次。
 *
 * 📌 **懒重建** —— 不用文件监听（进程重启、watcher 丢事件都麻烦），
 * 每次检索前比一下 mtime，变了就重建一次。
 */
export async function ensureMemoryIndexFresh(): Promise<void> {
  if (!memoryIndexIsStale()) return;
  await syncMemoryIndex();
}

/** 写入的结果 */
export interface MemoryWriteResult {
  ok: boolean;
  /** 失败原因（**给用户看的一句话**） */
  reason?: string;
  /** 写完之后的条目 */
  entries?: MemoryEntry[];
}

/**
 * 原子写 —— **写临时文件再 `rename`**。
 *
 * ⚠️ **失败不能留半个文件** —— 记忆文件损坏 = 用户全部记忆丢失。
 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    // ⚠️ **临时文件要清掉** —— 留着会让下次「读文件」看到半个文件
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败就算了 —— 真正的错误在下面抛
    }
    throw err;
  }
}

/**
 * 把条目写进文件（**重读 → 合并 → 原子写**）。
 *
 * ⚠️ **超上限不写** —— 只报告「已满」，**不静默丢弃、也不自动压缩**
 * （自动压缩会悄悄丢用户的记忆，见 [12-d D2](../../docs/12-d-需求-记忆与配置.md)）。
 */
export function writeMemoryEntries(
  file: MemoryFile,
  entries: MemoryEntry[],
  options: { audit?: boolean } = {},
): MemoryWriteResult {
  const current = readMemory(file);
  const content = renderMemoryFile(current.header, entries);
  const limit = memoryLimit(file);

  if (content.length > limit) {
    return {
      ok: false,
      reason:
        `${file}.md 已满（${content.length} / ${limit} 字符）—— ` +
        '不会自动压缩，请手动整合一下再写。',
      entries: current.entries,
    };
  }

  try {
    atomicWrite(current.path, content);
  } catch (err) {
    return {
      ok: false,
      reason: `写入失败：${err instanceof Error ? err.message : String(err)}`,
      entries: current.entries,
    };
  }

  if (options.audit) {
    void writeAudit('MEMORY_UPDATED', 'memory', file, { count: entries.length });
  }
  // 📌 **检索索引跟着更新** —— 记忆在文件里，索引在库里，得同步
  void syncMemoryIndex();
  return { ok: true, entries };
}

/** 新增或改写一条（**同名即改写** —— 不重复追加） */
export function upsertMemoryEntry(
  file: MemoryFile,
  entry: MemoryEntry,
  options: { audit?: boolean } = {},
): MemoryWriteResult {
  if (!isValidMemoryName(entry.name)) {
    return {
      ok: false,
      reason: `条目名「${entry.name}」不合法 —— 用 kebab-case（小写字母、数字、中划线）`,
    };
  }
  const current = readMemory(file);
  const index = current.entries.findIndex((item) => item.name === entry.name);
  const entries = [...current.entries];
  if (index >= 0) entries[index] = { ...entry, updated: entry.updated || todayStamp() };
  else entries.push({ ...entry, updated: entry.updated || todayStamp() });
  return writeMemoryEntries(file, entries, options);
}

/** 归档一条（**软删** —— 不再被召回，但文件里还看得见） */
export function archiveMemoryEntry(
  file: MemoryFile,
  name: string,
  options: { audit?: boolean } = {},
): MemoryWriteResult {
  const current = readMemory(file);
  const target = current.entries.find((item) => item.name === name);
  if (!target) return { ok: false, reason: `没有这条记忆：${name}` };
  const entries = current.entries.map((item) =>
    item.name === name ? { ...item, status: 'archived' as const, updated: todayStamp() } : item,
  );
  return writeMemoryEntries(file, entries, options);
}

/** 永久删除一条（**真的从文件里移除**） */
export function deleteMemoryEntry(
  file: MemoryFile,
  name: string,
  options: { audit?: boolean } = {},
): MemoryWriteResult {
  const current = readMemory(file);
  if (!current.entries.some((item) => item.name === name)) {
    return { ok: false, reason: `没有这条记忆：${name}` };
  }
  const entries = current.entries.filter((item) => item.name !== name);
  const result = writeMemoryEntries(file, entries, options);
  if (result.ok && options.audit) {
    void writeAudit('MEMORY_DELETED', 'memory', `${file}:${name}`, { name });
  }
  return result;
}

/** 清空一个文件（**保留用户自己写的文件头** —— 出厂不带头注了） */
export function clearMemoryEntries(
  file: MemoryFile,
  options: { audit?: boolean } = {},
): MemoryWriteResult {
  const result = writeMemoryEntries(file, [], options);
  if (result.ok && options.audit) {
    void writeAudit('MEMORY_DELETED', 'memory', file, { cleared: true });
  }
  return result;
}

/** 今天（`YYYY-MM-DD`） */
export function todayStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
