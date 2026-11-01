import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { config } from '../config.js';
import { DIRS, FILES, PROJECT_ROOT } from '../config/paths.js';
import { fallbackCreatedFiles } from '../config/ensure.js';

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
  'tool',
  'language',
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
 * 工具使用规范（`prompts/tool.md`）—— **每轮读，不缓存**。
 *
 * ⚠️ **空了就整段不出现** —— 少这段照样能跑，只是没了调用纪律的约束。
 */
export function readToolInstructions(): string {
  return readTextFile(join(DIRS.prompts, 'tool.md')).trim();
}

/**
 * 「用了兜底提示词」的提示语 —— **一切正常时返回空串**。
 *
 * ⚠️ **不要静默降级** —— 兜底模板很短（"够跑就行"），
 * 用户不知道就以为用的是仓库里的完整出厂版 → 行为变差却找不到原因
 * （见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 */
export function promptFallbackNotice(): string {
  const files = fallbackCreatedFiles();
  if (files.length === 0) return '';
  const names = files.map((file) => file.replace(`${PROJECT_ROOT}/`, ''));
  return (
    `⚠️ 用了兜底提示词：${names.join('、')} 缺失，启动时已用出厂兜底模板写回。` +
    '兜底模板很短，行为会比仓库里的完整版本差 —— 建议 git checkout 还原这些文件'
  );
}

/**
 * 回复语言指令（`.env` 的 `SYSTEM_LANGUAGE`）—— **每轮拼上**。
 *
 * ⚠️ **这个 key 的语义要写清楚**：它管的是 **Agent 回复用什么语言**，
 * 不是界面语言 —— 界面文案是写死的中文（前端没有设置页，见 [04-c](../docs/04-c-ui-配置入口.md)）。
 *
 * 📌 **默认 `zh-CN`** —— 与出厂提示词（中文）一致。
 */
export function languageInstruction(): string {
  const lang = config.SYSTEM_LANGUAGE.trim();
  if (lang === '') return '';
  return `## 回复语言\n\n用 **${lang}** 回复用户（语言由 \`.env\` 的 \`SYSTEM_LANGUAGE\` 决定）。`;
}

/** 缓存标记（**Anthropic 的 `cache_control`**） */
const CACHE_CONTROL = { type: 'ephemeral' as const };

/**
 * 系统提示词消息 —— **要不要打缓存标记**。
 *
 * 📌 **为什么值得打** —— 系统提示词每轮都要重复注入
 * （`AGENTS.md` + 记忆 + 技能 + 工具清单），
 * 缓存命中时这段**按打折价计费**，能省下一大截。
 *
 * ⚠️ **端点未必支持** —— 国产兼容端点有可能直接报 400，
 *    那时走「去掉标记重试」那条路（见 `agent/model-stream.ts`）。
 */
export function systemMessage(text: string, cache: boolean): SystemMessage {
  if (!cache) return new SystemMessage(text);
  return new SystemMessage({
    content: [{ type: 'text', text, cache_control: CACHE_CONTROL }] as never,
  });
}

/**
 * 把消息里的缓存标记去掉 —— **端点不支持时的退路**。
 *
 * 📌 **只动系统消息** —— 其余消息本来就是逐轮变化的，缓存没有意义。
 */
export function stripCacheControl(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.getType() !== 'system') return message;
    const content = message.content;
    if (typeof content === 'string') return message;
    if (!Array.isArray(content)) return message;
    const text = content
      .map((block) => {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          const value = (block as { text?: unknown }).text;
          return typeof value === 'string' ? value : '';
        }
        return '';
      })
      .join('');
    return new SystemMessage(text);
  });
}

/**
 * 组装系统提示词 = **人格（`SOUL.md`）+ 系统提示词（`prompts/system.md`）**。
 *
 * 📌 **`AGENTS.md`（项目指令）走 `{{agents}}` 占位符** ——
 * 它是「这个项目的规矩」，跟「你是谁」（人格）是两回事，
 * 所以单独一段，不跟 `SOUL.md` 混在一起。
 *
 * 📌 **`prompts/tool.md`（工具使用规范）走 `{{tool}}` 占位符** ——
 * ⚠️ **模板里没写 `{{tool}}` 也会注入**（追加到末尾）——
 * 用户改过 `system.md` 的话，只靠占位符会让 `tool.md`
 * 又变回「写了没人读」的文件（见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 */
export function buildSystemPrompt(ctx: PromptContext = {}): string {
  const soul = readTextFile(personalityPath(ctx.personality)).trim();
  const system = readTextFile(join(DIRS.prompts, 'system.md')).trim();
  const tool = readToolInstructions();
  const language = languageInstruction();

  const rendered = renderTemplate(system, {
    date: ctx.date ?? today(),
    tools: ctx.tools ?? '（本期尚未接入工具）',
    // 📌 **工具使用规范** —— `prompts/tool.md` 的正文
    tool,
    // 📌 **回复语言** —— `.env` 的 `SYSTEM_LANGUAGE`
    language,
    // ⚠️ **技能段为空就整段不出现** —— 不要留「（暂无）」这种占位
    skills: ctx.skills ?? '',
    memories: ctx.memories ?? '（暂无）',
    retrieval: ctx.retrieval ?? '',
    summary: ctx.summary ?? '',
    // 📌 **项目指令为空就整段不出现** —— 没有 AGENTS.md 的项目不该留空标题
    agents: ctx.agents ?? '',
  });

  const sections = [soul, rendered];
  // ⚠️ **模板没写 `{{tool}}` 也要注入** —— 否则 `tool.md` 会重新变成哑巴文件
  if (tool && !system.includes('{{tool}}')) sections.push(tool);
  // ⚠️ **同上** —— `SYSTEM_LANGUAGE` 不能因为模板被改过就失效
  if (language && !system.includes('{{language}}')) sections.push(language);
  return sections.filter(Boolean).join('\n\n---\n\n');
}
