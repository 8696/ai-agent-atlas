import { z } from 'zod';
import { config } from '../../config.js';
import {
  addMemory,
  archiveMemory,
  clearMemory,
  deleteMemory,
  editMemory,
  listMemories,
  memoryUsageHeader,
  noteManualMemoryWrite,
} from '../../services/memory/index.js';
import type { MemoryEntry, MemoryFile } from '../../services/memory/types.js';
import { parseArgs } from '../args.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * 记忆管理工具 —— `memory`（查看 / 新增 / 改写 / 归档）与
 * `memory_forget`（永久删除 / 清空）
 * （见 [12-d D4](../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **为什么拆成两个工具** —— 敏感档是**按工具**定的，不按参数定：
 * - `memory` —— `normal` 档（**不弹确认**）——
 *   新增/改写记忆是可逆的（条目还在文件里），而且用户是明说的
 * - `memory_forget` —— `high` 档（**弹确认卡片**）——
 *   永久删除不可恢复，值得让用户点一下
 *
 * ⚠️ **记忆有上限** —— `MEMORY.md` 2200 / `USER.md` 1375 字符，
 *    超了**只报告不压缩**（见 [12-d D2](../../docs/12-d-需求-记忆与配置.md)）。
 *    工具返回里带用量表头，模型才知道该整合还是该新增。
 */

/** 记忆文件（**两个**） */
const fileSchema = z.enum(['MEMORY', 'USER']);

/** 条目类型 */
const kindSchema = z.enum(['fact', 'context', 'preference', 'profile']);

/** 条目名（**kebab-case** —— 合法性与 `isValidMemoryName` 同一套） */
const nameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: '条目名要用 kebab-case（小写字母、数字、中划线），例如 prefers-pnpm',
  });

/** 同步结果 → Promise（**工具实现可以是同步的**） */
function done(result: ToolResult): Promise<ToolResult> {
  return Promise.resolve(result);
}

/** 出错 → 一个失败的结果（**不是异常** —— 异常在包装层转成错误文本） */
function fail(message: string): ToolResult {
  return { ok: false, output: `记忆操作失败：${message}`, error: message };
}

/** 渲染一条条目（**给模型看**） */
function formatEntry(file: MemoryFile, entry: MemoryEntry): string {
  const flags = [
    entry.kind,
    entry.source === 'manual' ? '手动' : '自动',
    entry.status === 'archived' ? '已归档' : '',
    entry.updated || '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `- [${file}] ${entry.name}（${flags}）：${entry.body}`;
}

/** 渲染全部条目 */
function formatList(file?: MemoryFile): string {
  const items = listMemories(file);
  const header = memoryUsageHeader();
  if (items.length === 0) {
    return `${header}\n（还没有记忆条目）`;
  }
  return [header, ...items.map((item) => formatEntry(item.file, item.entry))].join('\n');
}

/** `memory` 的入参 */
const memorySchema = z.object({
  /** 做什么 */
  action: z.enum(['list', 'add', 'edit', 'archive']),
  /** 哪个文件（**`list` 可以不给** —— 不给就是两个都列） */
  file: fileSchema.optional(),
  /** 条目名（**`add` / `edit` / `archive` 必填**） */
  name: nameSchema.optional(),
  /** 正文（**`add` 必填**；`edit` 不给就只改类型） */
  body: z.string().min(1).max(2000).optional(),
  /** 条目类型 */
  kind: kindSchema.optional(),
});

export const memoryTool: ToolDefinition = {
  name: 'memory',
  description:
    '管理长期记忆（跨会话记住的偏好与事实，存在 data/memory/MEMORY.md 与 USER.md 两个 Markdown 文件里）。' +
    '动作：list（列出全部条目）· add（新增一条，同名即改写）· edit（改写已有条目）· archive（归档：不再被召回，但文件里还看得见，可恢复）。' +
    'MEMORY.md 装环境侧事实（端口、路径、命令的坑），USER.md 装用户侧偏好与画像。' +
    'name 用 kebab-case 短标题（如 prefers-pnpm），body 一句话。' +
    '用户说「记住 X」「别记了那条」「把那条记忆改成 Y」时用这个工具，' +
    '不要只在回答里口头答应。' +
    '⚠️ 永久删除与清空用 memory_forget。',
  schema: memorySchema,
  sensitivity: 'normal',
  source: 'builtin',
  enabled: config.MEMORY_ENABLED,
  // 📌 **子代理不碰记忆** —— 记忆是跟用户直接对话的事，
  //    让子代理静默改写用户的画像不合适
  executor: 'none',
  invoke(args, context): Promise<ToolResult> {
    try {
      const input = parseArgs(memorySchema, args);

      switch (input.action) {
        case 'list': {
          return done({
            ok: true,
            output: formatList(input.file),
            data: { action: 'list', file: input.file ?? null },
          });
        }

        case 'add': {
          if (!input.file || !input.name || !input.body) {
            return done(fail('`add` 需要 file（MEMORY / USER）、name 与 body 三样'));
          }
          const result = addMemory({
            file: input.file,
            name: input.name,
            body: input.body,
            ...(input.kind ? { kind: input.kind } : {}),
          });
          if (!result.ok) return done(fail(result.message));
          noteManualMemoryWrite(context.sessionId);
          return done({
            ok: true,
            output: `${result.message}\n${formatList()}`,
            data: { action: 'add', file: input.file, name: input.name },
          });
        }

        case 'edit': {
          if (!input.file || !input.name) {
            return done(fail('`edit` 需要 file（MEMORY / USER）与 name'));
          }
          const result = editMemory({
            file: input.file,
            name: input.name,
            ...(input.body ? { body: input.body } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
          });
          if (!result.ok) return done(fail(result.message));
          noteManualMemoryWrite(context.sessionId);
          return done({
            ok: true,
            output: `${result.message}\n${formatList()}`,
            data: { action: 'edit', file: input.file, name: input.name },
          });
        }

        case 'archive': {
          if (!input.file || !input.name) {
            return done(fail('`archive` 需要 file（MEMORY / USER）与 name'));
          }
          const result = archiveMemory(input.file, input.name);
          if (!result.ok) return done(fail(result.message));
          noteManualMemoryWrite(context.sessionId);
          return done({
            ok: true,
            output: `${result.message}\n${formatList()}`,
            data: { action: 'archive', file: input.file, name: input.name },
          });
        }

        default:
          return done(fail(`不认识的动作：${String(input.action)}`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return done(fail(message));
    }
  },
};

/** `memory_forget` 的入参 */
const forgetSchema = z.object({
  /** 做什么 */
  action: z.enum(['delete', 'clear']),
  /** 哪个文件（**必填** —— 不猜） */
  file: fileSchema,
  /** 条目名（**`delete` 必填**） */
  name: nameSchema.optional(),
});

export const memoryForgetTool: ToolDefinition = {
  name: 'memory_forget',
  description:
    '永久删除记忆条目，或清空整个记忆文件（**不可恢复** —— 执行前会弹确认卡片给用户批准）。' +
    '动作：delete（删掉一条，必须给 name）· clear（清空一个文件的所有条目）。' +
    '用户说「把那条记忆删掉」「清空我的记忆」「别记我的地址了」时用这个。' +
    '⚠️ 只是想让某条记忆不再被召回（但仍想留着），用 memory 的 archive —— 它可恢复。',
  schema: forgetSchema,
  sensitivity: 'high',
  riskNote: '永久删除记忆 —— 删掉后无法恢复（确认后会立即执行）',
  source: 'builtin',
  enabled: config.MEMORY_ENABLED,
  executor: 'none',
  invoke(args, context): Promise<ToolResult> {
    try {
      const input = parseArgs(forgetSchema, args);

      if (input.action === 'delete') {
        if (!input.name) return done(fail('`delete` 需要 name（要删哪一条）'));
        const result = deleteMemory(input.file, input.name);
        if (!result.ok) return done(fail(result.message));
        noteManualMemoryWrite(context.sessionId);
        return done({
          ok: true,
          output: `${result.message}\n${formatList()}`,
          data: { action: 'delete', file: input.file, name: input.name },
        });
      }

      const result = clearMemory(input.file);
      if (!result.ok) return done(fail(result.message));
      noteManualMemoryWrite(context.sessionId);
      return done({
        ok: true,
        output: `${result.message}\n${formatList()}`,
        data: { action: 'clear', file: input.file },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return done(fail(message));
    }
  },
};

/** 记忆工具 */
export const memoryTools: ToolDefinition[] = [memoryTool, memoryForgetTool];
