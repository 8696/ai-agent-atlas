import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DIRS, FILES, PROJECT_ROOT } from '../config/paths.js';

/**
 * 提示词与上下文文件 —— **每轮读文件，不缓存**（见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 📌 **改完下一轮就生效，不用重启**。
 *
 * ⚠️ **未识别的占位符原样保留** —— 清空会把用户写进模板的内容吞掉。
 */

/** 系统提示词里认识的占位符 */
export const KNOWN_PLACEHOLDERS = [
  'date',
  'tools',
  'skills',
  'memories',
  'retrieval',
  'summary',
] as const;

/**
 * 替换 `{{占位符}}`。
 *
 * ⚠️ **未识别的占位符原样保留**（`{{foo}}` → `{{foo}}`）。
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? '') : match,
  );
}

/** 读文件；读不到（不存在 / 无权限）返回空串 —— **不让提示词问题把整轮对话打挂** */
export function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** 本轮注入系统提示词的上下文 */
export interface PromptContext {
  /** 日期（默认今天） */
  date?: string | undefined;
  /** 可用工具清单 */
  tools?: string | undefined;
  /** 已加载技能 */
  skills?: string | undefined;
  /** 召回的记忆 */
  memories?: string | undefined;
  /** 跨会话检索的摘要（**排在记忆之后**） */
  retrieval?: string | undefined;
  /** 会话摘要（**早期对话折出来的**） */
  summary?: string | undefined;
  /** 人格文件名（**SOUL.md 的文件名，不含路径**） */
  personality?: string | undefined;
}

/** 今天（本地时区粗略取 YYYY-MM-DD） */
export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 可用的人格文件（**项目根的 `SOUL*.md`**）。
 *
 * 📌 **换人格 = 换一个文件** —— 对标 Hermes 的人格文件。
 */
export function listPersonalities(): string[] {
  const names = ['SOUL.md'];
  try {
    for (const file of readdirSync(PROJECT_ROOT)) {
      if (!file.startsWith('SOUL') || !file.endsWith('.md')) continue;
      if (file === 'SOUL.md') continue;
      names.push(file);
    }
  } catch {
    // 读不到目录就只留默认的 SOUL.md
  }
  return names;
}

/**
 * 人格文件的路径（**只允许项目根的 `SOUL*.md`**）。
 *
 * ⚠️ **不接受路径** —— `../../etc/passwd` 这种输入要挡住。
 */
export function personalityPath(name: string | undefined): string {
  if (!name) return FILES.soul;
  const safe = basename(name);
  if (!/^SOUL[A-Za-z0-9_-]*\.md$/.test(safe)) return FILES.soul;
  return join(PROJECT_ROOT, safe);
}

/**
 * 组装系统提示词 = **人格（`SOUL.md`）+ 系统提示词（`prompts/system.md`）**。
 *
 * ⚠️ `AGENTS.md` 是**项目级指令**，不进系统提示词（那是给人看的文件，不是 Atlas 的人格）。
 */
export function buildSystemPrompt(ctx: PromptContext = {}): string {
  const soul = readTextFile(personalityPath(ctx.personality)).trim();
  const system = readTextFile(join(DIRS.prompts, 'system.md')).trim();

  const rendered = renderTemplate(system, {
    date: ctx.date ?? today(),
    tools: ctx.tools ?? '（本期尚未接入工具）',
    // ⚠️ **技能段为空就整段不出现** —— 不要留「（暂无）」这种占位
    skills: ctx.skills ?? '',
    memories: ctx.memories ?? '（暂无）',
    retrieval: ctx.retrieval ?? '',
    summary: ctx.summary ?? '',
  });

  return [soul, rendered].filter(Boolean).join('\n\n---\n\n');
}
