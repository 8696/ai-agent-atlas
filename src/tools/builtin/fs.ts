import {
  readdirSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { paths } from '../../config.js';
import {
  SandboxError,
  assertNotWorkspaceRoot,
  resolveContextFile,
  resolveInWorkspace,
  resolveInWorkspaceKeepLink,
  toWorkspaceRelative,
} from '../../lib/security/sandbox.js';
import { isProtectedContextFile } from '../../lib/security/context-files.js';
import { parseArgs, schemas } from '../args.js';
import { truncateOutput } from '../output.js';
import { hasWildcard, matchesGlob } from '../glob.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * 文件与目录工具 —— `read_file` / `write_file` / `list_dir` / `delete_path` / `search_files`
 * （见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **所有路径都过 `lib/security/sandbox.ts`** —— 越界明确报错，不静默失败。
 * ⚠️ **给模型的路径相对项目根** —— 例如 `data/skills/某技能/SKILL.md`，
 *    不要再加 `data/workspace` 前缀。
 */

/** 搜索时默认跳过的目录（**别把 `node_modules` 翻一遍**） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage']);

/** 搜索时默认跳过的文件 */
const SKIP_FILES = new Set(['vectors.db']);

/**
 * 项目上下文文件（`AGENTS.md` / `SOUL.md`）的读取上限（**字符**）。
 *
 * ⚠️ **比普通文件大得多** —— 系统提示词里只带了它们的前一截，
 * 模型要读全文就得**一次读完**（分段读会烧光工具步数）。
 */
const CONTEXT_FILE_MAX_CHARS = 20_000;

/** 出错 → 一个失败的结果（**不是异常** —— 异常在包装层转成错误文本） */
function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof SandboxError ? error.code : 'TOOL_FAILED';
  return { ok: false, output: `工具执行失败：${message}`, error: `${code}: ${message}` };
}

/** 同步结果 → Promise（**工具实现可以是同步的**） */
function done(result: ToolResult): Promise<ToolResult> {
  return Promise.resolve(result);
}

/** `read_file` —— 读文件内容（**支持行范围**） */
const readFileSchema = z.object({
  path: schemas.path,
  /** 从第几行开始（1 起） */
  offset: z.number().int().min(1).optional(),
  /** 读多少行 */
  limit: z.number().int().min(1).max(5000).optional(),
});

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '读取项目里的文本文件。路径相对项目根，例如 `data/skills/某技能/SKILL.md`，' +
    '不要加 `data/workspace` 前缀。可以指定行范围（offset 从 1 开始，limit 是行数）。' +
    '文件很大时会自动截断并注明原始长度。' +
    '`AGENTS.md` / `SOUL.md` 也能读 —— 系统提示词里只带了前一截，要看全文就用这个。',
  schema: readFileSchema,
  sensitivity: 'normal',
  keywords: ['读文件', '读取', '读一下', '看看文件', '打开文件', '看一下文件', 'cat', 'read'],
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(readFileSchema, args);
      // 📌 **项目上下文文件（`AGENTS.md` / `SOUL.md`）在项目根，不在工作区里** ——
      //    它们只被截断着注入系统提示词，模型要全文得自己读（**只读**）
      const contextFile = resolveContextFile(input.path);
      const target = contextFile ?? resolveInWorkspace(input.path, paths.workspaceRoot);
      const stat = lstatSync(target);
      if (stat.isDirectory()) {
        return done(fail(new SandboxError(`${input.path} 是目录，用 list_dir 看看里面有什么`)));
      }
      const raw = readFileSync(target, 'utf8');
      const lines = raw.split('\n');
      const start = (input.offset ?? 1) - 1;
      const end = input.limit ? start + input.limit : lines.length;
      const slice = lines.slice(start, end).join('\n');
      // 📌 **上下文文件一次给够** —— 分段读会烧光工具步数
      const clipped = contextFile
        ? truncateOutput(slice, CONTEXT_FILE_MAX_CHARS)
        : truncateOutput(slice);
      // 📌 **上下文文件不在工作区里** —— 相对路径算不出来，就用文件名
      const relative = contextFile
        ? input.path.trim().toLowerCase()
        : toWorkspaceRelative(target, paths.workspaceRoot);
      const prefix = `文件：${relative}（共 ${lines.length} 行，本次返回第 ${start + 1}–${Math.min(end, lines.length)} 行）\n`;
      return done({
        ok: true,
        output: `${prefix}${clipped.text}`,
        data: { path: relative, lines: lines.length, returned: Math.max(0, end - start) },
        truncated: clipped.truncated,
        originalLength: clipped.originalLength,
        // 📌 **上下文文件不过全局截断** —— 截掉头只剩尾，比读不到更糟
        ...(contextFile ? { truncate: false } : {}),
      });
    } catch (err) {
      return done(fail(err));
    }
  },
};

/** `write_file` —— 写 / 追加文件（**覆盖要显式 overwrite**） */
const writeFileSchema = z.object({
  path: schemas.path,
  content: schemas.text(),
  /** 覆盖已有文件必须显式传 true */
  overwrite: z.boolean().optional(),
  /** 追加到文件末尾 */
  append: z.boolean().optional(),
});

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '把内容写进项目里的文件。路径相对项目根，例如 `data/skills/某技能/SKILL.md`。' +
    '默认**不覆盖**已有文件 —— 要覆盖必须显式传 overwrite=true，' +
    '要追加传 append=true。父目录不存在会自动创建。' +
    '人格、项目指令和提示词文件只读，不能写。',
  schema: writeFileSchema,
  sensitivity: 'high',
  keywordGroups: [
    [
      '写',
      '写入',
      '写进',
      '存',
      '保存',
      '改成',
      '改一下',
      '生成文件',
      '新建文件',
      '覆盖',
      'write',
      'save',
    ],
    ['文件', '代码', '内容', 'readme', 'md', '配置', '脚本', 'json', 'yaml', 'yml'],
  ],
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(writeFileSchema, args);
      const target = resolveInWorkspace(input.path, paths.workspaceRoot);
      if (isProtectedContextFile(target)) {
        return done(fail(new SandboxError('人格、项目指令和提示词文件只读，不能写')));
      }
      const exists = lstatSync(target, { throwIfNoEntry: false });
      if (exists && !input.overwrite && !input.append) {
        return done({
          ok: false,
          output: `文件 ${input.path} 已存在 —— 要覆盖请传 overwrite=true，要追加请传 append=true`,
          error: 'FILE_EXISTS',
        });
      }
      mkdirSync(dirname(target), { recursive: true });
      if (input.append && exists) {
        writeFileSync(target, input.content, { flag: 'a' });
      } else {
        writeFileSync(target, input.content, 'utf8');
      }
      const relative = toWorkspaceRelative(target, paths.workspaceRoot);
      const action = input.append ? '追加' : exists ? '覆盖' : '新建';
      return done({
        ok: true,
        output: `已${action} ${relative}（${input.content.length} 字符）`,
        data: { path: relative, action, bytes: input.content.length },
      });
    } catch (err) {
      return done(fail(err));
    }
  },
};

/** `list_dir` —— 列目录（**不递归**） */
const listDirSchema = z.object({
  path: schemas.path.optional(),
  /** 最多列多少项 */
  limit: z.number().int().min(1).max(1000).optional(),
});

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description:
    '列出项目里某个目录的内容（不递归；要递归搜索用 search_files）。' +
    '路径相对项目根。不传 path 就是项目根。技能在 `data/skills`。',
  schema: listDirSchema,
  sensitivity: 'low',
  keywords: ['列目录', '列出', '目录', 'ls', '看看有什么', '有什么文件', '文件夹'],
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(listDirSchema, args);
      // ⚠️ **允许就落在工作区根上** —— 「列出工作区根」是正常操作
      const target = resolveInWorkspace(input.path ?? '.', paths.workspaceRoot, {
        allowRoot: true,
      });
      const stat = lstatSync(target);
      if (!stat.isDirectory()) {
        return done(fail(new SandboxError(`${input.path ?? '.'} 不是目录`)));
      }
      const entries = readdirSync(target, { withFileTypes: true });
      const limit = input.limit ?? 200;
      const shown = entries.slice(0, limit);
      const lines = shown.map((entry) => {
        const kind = entry.isDirectory() ? '目录' : entry.isSymbolicLink() ? '软链' : '文件';
        return `${kind}\t${entry.name}`;
      });
      const header = `目录：${toWorkspaceRelative(target, paths.workspaceRoot)}（共 ${entries.length} 项${entries.length > shown.length ? `，只列前 ${shown.length} 项` : ''}）\n`;
      return done({
        ok: true,
        output: `${header}${lines.join('\n') || '（空目录）'}`,
        data: {
          path: toWorkspaceRelative(target, paths.workspaceRoot),
          total: entries.length,
          entries: shown.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file',
          })),
        },
      });
    } catch (err) {
      return done(fail(err));
    }
  },
};

/** `delete_path` —— 删除文件 / 目录（**不可撤销**） */
const deletePathSchema = z.object({
  path: schemas.path,
});

export const deletePathTool: ToolDefinition = {
  name: 'delete_path',
  description:
    '删除项目里的文件或目录。路径相对项目根。**不可撤销** —— 删之前先确认清楚。' +
    '项目根目录不能删；人格、项目指令和提示词文件不能删；软链只删链接本身，不删它指向的东西。',
  schema: deletePathSchema,
  sensitivity: 'high',
  keywordGroups: [
    ['删', '删除', '删掉', '清理', '移除', 'rm', 'delete', 'purge'],
    ['文件', '目录', '文件夹', '路径', 'tmp', '临时', 'data'],
  ],
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(deletePathSchema, args);
      // ⚠️ **最后一段的软链不要解开** —— 解开了「删软链」就变成「删它指向的东西」
      //    （见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）
      const target = resolveInWorkspaceKeepLink(input.path, paths.workspaceRoot);
      assertNotWorkspaceRoot(target, paths.workspaceRoot);
      if (isProtectedContextFile(target)) {
        return done(fail(new SandboxError('人格、项目指令和提示词文件只读，不能删')));
      }
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (!stat) {
        return done({ ok: false, output: `路径不存在：${input.path}`, error: 'NOT_FOUND' });
      }
      const relative = toWorkspaceRelative(target, paths.workspaceRoot);
      if (stat.isSymbolicLink()) {
        // ⚠️ **软链只删链接本身** —— 跟着删会误删工作区外的东西
        unlinkSync(target);
      } else if (stat.isDirectory()) {
        rmSync(target, { recursive: true, force: true });
      } else {
        rmSync(target, { force: true });
      }
      return done({
        ok: true,
        output: `已删除 ${relative}`,
        data: { path: relative, type: stat.isDirectory() ? 'dir' : 'file' },
      });
    } catch (err) {
      return done(fail(err));
    }
  },
};

/** `search_files` —— 按名 / 内容搜索 */
const searchFilesSchema = z.object({
  /** 搜索根目录（默认工作区根） */
  path: schemas.path.optional(),
  /** 文件名通配（`*.ts`）；不传就匹配所有 */
  pattern: schemas.text(200).optional(),
  /** 文件内容里要包含的字符串 */
  content: schemas.text(500).optional(),
  /** 最多返回多少条 */
  limit: z.number().int().min(1).max(500).optional(),
  /** 递归深度上限（默认 6） */
  maxDepth: z.number().int().min(1).max(20).optional(),
});

export const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description:
    '在项目里按文件名通配（pattern，如 `*.ts`）或按内容（content）搜索文件。' +
    '路径相对项目根。默认跳过 node_modules / .git / dist 这些目录。',
  schema: searchFilesSchema,
  sensitivity: 'low',
  keywords: ['搜文件', '搜索文件', '查找文件', '在项目里找', 'grep', 'find', '全文搜'],
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(searchFilesSchema, args);
      // ⚠️ **允许就落在工作区根上** —— 「在工作区里搜」是正常操作
      const root = resolveInWorkspace(input.path ?? '.', paths.workspaceRoot, {
        allowRoot: true,
      });
      const limit = input.limit ?? 100;
      const maxDepth = input.maxDepth ?? 6;
      const hits: Array<{ path: string; matched: boolean }> = [];

      const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth || hits.length >= limit) return;
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (hits.length >= limit) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(full, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          if (SKIP_FILES.has(entry.name)) continue;
          const rel = relative(root, full).split(sep).join('/');
          const nameOk =
            !input.pattern || !hasWildcard(input.pattern)
              ? !input.pattern || entry.name.toLowerCase() === input.pattern.toLowerCase()
              : matchesGlob(rel, input.pattern) || matchesGlob(entry.name, input.pattern);
          if (!nameOk) continue;

          let contentOk = true;
          if (input.content) {
            try {
              const stat = lstatSync(full);
              // ⚠️ **只搜小文件** —— 大文件翻一遍纯属烧钱
              if (stat.size > 512 * 1024) continue;
              contentOk = readFileSync(full, 'utf8').includes(input.content);
            } catch {
              contentOk = false;
            }
          }
          if (contentOk) hits.push({ path: rel, matched: true });
        }
      };

      walk(root, 0);

      const rootLabel = toWorkspaceRelative(root, paths.workspaceRoot);
      const lines = hits.map((hit) => hit.path);
      return done({
        ok: true,
        output: `在 ${rootLabel} 下找到 ${hits.length} 个匹配：\n${lines.join('\n') || '（没有匹配）'}`,
        data: { root: rootLabel, count: hits.length, matches: lines },
      });
    } catch (err) {
      return done(fail(err));
    }
  },
};

/** 文件与目录这一组工具 */
export const fsTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  deletePathTool,
  searchFilesTool,
];
