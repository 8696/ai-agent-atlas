import { scanMemoryWrite } from './scan.js';
import {
  archiveMemoryEntry,
  clearMemoryEntries,
  deleteMemoryEntry,
  readMemory,
  upsertMemoryEntry,
} from './store.js';
import { MEMORY_FILES, type MemoryEntry, type MemoryFile, type MemoryKind } from './types.js';

/**
 * 长期记忆的对外接口 —— **一个入口**（见 [12-d D2](../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **CLI / 网关 / 模型都走这里** —— 不各自拼文件路径。
 *
 * ⚠️ **写盘前一律过扫描** —— 记忆是持久化的注入通道，
 * 命中注入 / 凭据 / 不可见字符就**拒绝写入**（不是告警）。
 */

export * from './types.js';
export {
  readMemory,
  memoryLimit,
  memoryPath,
  syncMemoryIndex,
} from './store.js';
export { buildMemorySection, pickMemories } from './inject.js';
export { runMemoryExtraction, hasMemorySignal, parseOps } from './extract.js';
export { scanMemoryWrite } from './scan.js';

/** 一次写入的结果 */
export interface MemoryOpResult {
  ok: boolean;
  /** 给人看的一句话（**成功时是做了什么**） */
  message: string;
}

/** 人工加一条（**来源记 `manual`** —— 人写的更可信） */
export function addMemory(input: {
  file: MemoryFile;
  name: string;
  kind?: MemoryKind;
  body: string;
}): MemoryOpResult {
  const scan = scanMemoryWrite(`${input.name}\n${input.body}`);
  if (!scan.ok) {
    return { ok: false, message: `拒绝写入：${scan.reasons.join('；')}` };
  }
  const entry: MemoryEntry = {
    name: input.name.trim(),
    kind: input.kind ?? (input.file === 'USER' ? 'preference' : 'fact'),
    confidence: 1,
    source: 'manual',
    updated: '',
    status: 'active',
    body: input.body.trim(),
  };
  const result = upsertMemoryEntry(input.file, entry, { audit: true });
  return result.ok
    ? { ok: true, message: `已写入 ${input.file}.md · ${entry.name}` }
    : { ok: false, message: result.reason ?? '写入失败' };
}

/** 改写一条（**正文变了才算改写**） */
export function editMemory(input: {
  file: MemoryFile;
  name: string;
  body?: string;
  kind?: MemoryKind;
}): MemoryOpResult {
  const content = readMemory(input.file);
  const existing = content.entries.find((item) => item.name === input.name);
  if (!existing) return { ok: false, message: `没有这条记忆：${input.name}` };

  const body = (input.body ?? existing.body).trim();
  const scan = scanMemoryWrite(`${input.name}\n${body}`);
  if (!scan.ok) return { ok: false, message: `拒绝写入：${scan.reasons.join('；')}` };

  const result = upsertMemoryEntry(
    input.file,
    {
      ...existing,
      body,
      ...(input.kind ? { kind: input.kind } : {}),
      source: 'manual',
      updated: '',
    },
    { audit: true },
  );
  return result.ok
    ? { ok: true, message: `已改写 ${input.file}.md · ${existing.name}` }
    : { ok: false, message: result.reason ?? '改写失败' };
}

/** 归档一条（**软删** —— 不再被召回，文件里还看得见） */
export function archiveMemory(file: MemoryFile, name: string): MemoryOpResult {
  const result = archiveMemoryEntry(file, name, { audit: true });
  return result.ok
    ? { ok: true, message: `已归档 ${file}.md · ${name}` }
    : { ok: false, message: result.reason ?? '归档失败' };
}

/** 永久删除一条（**真的从文件里移除**） */
export function deleteMemory(file: MemoryFile, name: string): MemoryOpResult {
  const result = deleteMemoryEntry(file, name, { audit: true });
  return result.ok
    ? { ok: true, message: `已删除 ${file}.md · ${name}` }
    : { ok: false, message: result.reason ?? '删除失败' };
}

/** 清空一个文件（**保留文件头**） */
export function clearMemory(file: MemoryFile): MemoryOpResult {
  const result = clearMemoryEntries(file, { audit: true });
  return result.ok
    ? { ok: true, message: `已清空 ${file}.md` }
    : { ok: false, message: result.reason ?? '清空失败' };
}

/** 列出所有条目（**给 CLI / `/skills` 之类的命令看**） */
export function listMemories(file?: MemoryFile): Array<{ file: MemoryFile; entry: MemoryEntry }> {
  const files = file ? [file] : MEMORY_FILES;
  const out: Array<{ file: MemoryFile; entry: MemoryEntry }> = [];
  for (const item of files) {
    for (const entry of readMemory(item).entries) out.push({ file: item, entry });
  }
  return out;
}
