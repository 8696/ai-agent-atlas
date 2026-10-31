import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../config.js';
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
  'agents',
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
  /** 项目指令（**`AGENTS.md` 的正文**） */
  agents?: string | undefined;
}

/**
 * 把项目指令正文拼成一段（**含小标题**）。
 *
 * ⚠️ **纯函数** —— 文件读不读是另一回事（`readAgentsInstructions` 管那个）。
 */
export function formatAgentsInstructions(raw: string, maxChars: number): string {
  const text = raw.trim();
  if (text === '') return '';
  const body =
    text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars)}\n\n` +
        `（⚠️ AGENTS.md 已截断 —— 这里只用了前 ${maxChars} 字，全文共 ${text.length} 字。` +
        `要看后面的章节，用 read_file 读 "AGENTS.md" 拿全文；完整内容也在项目根目录的 AGENTS.md）`;
  return `## 项目指令（AGENTS.md）\n\n${body}`;
}

/**
 * 项目指令（`AGENTS.md`）—— **每轮读文件，不缓存**。
 *
 * ⚠️ **文件不存在 → 跳过** —— 它是**项目**的指令文件，不是 Atlas 的出厂文件。
 * ⚠️ **超长会截断** —— 项目指令可能有几万字，
 * **每轮全量注入会把上下文吃光**（预算按月算的），
 * 所以按 `AGENTS_MAX_CHARS` 截断，并**明说截断了**（别让模型以为看到了全文）。
 */
export function readAgentsInstructions(maxChars = config.AGENTS_MAX_CHARS): string {
  return formatAgentsInstructions(readTextFile(FILES.agents), maxChars);
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
 * 📌 **`AGENTS.md`（项目指令）走 `{{agents}}` 占位符** ——
 * 它是「这个项目的规矩」，跟「你是谁」（人格）是两回事，
 * 所以单独一段，不跟 `SOUL.md` 混在一起。
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
    // 📌 **项目指令为空就整段不出现** —— 没有 AGENTS.md 的项目不该留空标题
    agents: ctx.agents ?? '',
  });

  return [soul, rendered].filter(Boolean).join('\n\n---\n\n');
}
