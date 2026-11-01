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
 * ⚠️ **每轮都会变的占位符** —— 它们决定了提示词缓存能不能命中。
 *
 * 📌 **为什么单列一份** ——
 * Anthropic 的提示词缓存是**前缀缓存**：
 * 从消息开头到 `cache_control` 块为止的内容必须**逐字节相同**才命中。
 * 以前整套系统提示词是一个块、缓存标记打在**末尾**，
 * 于是**每轮都变的那几个占位符把整个前缀作废了** ——
 * 工具池每轮按相关度裁剪（`{{tools}}`）、记忆 / 检索 / 技能 / 摘要每轮变、
 * 日期每天变 → **缓存命中率恒为 0**。
 *
 * 📌 **拆开之后** —— 稳定的那一段放在 `cache_control` **之前**，
 * 易变的那一段放在之后 → 端点支持缓存时就能命中。
 *
 * ⚠️ **端点不支持缓存的话，这个拆分不省任何钱** ——
 *    智谱的 Anthropic 兼容端点就**只认 `cache_control` 字段、不实现缓存语义**
 *    （实测 25,217 token 的稳定前缀连发两次，`cache_read_input_tokens` 都是 0）。
 *    用 `yarn cache:probe` 可以当场测一个端点到底支不支持。
 */
export const VOLATILE_PLACEHOLDERS = [
  'date',
  'tools',
  'skills',
  'summary',
  'memories',
  'retrieval',
] as const;

/** 这一行是不是含了「每轮都会变」的占位符 */
function hasVolatilePlaceholder(line: string): boolean {
  return VOLATILE_PLACEHOLDERS.some((key) => line.includes(`{{${key}}}`));
}

/** 这一行是不是 Markdown 标题 */
function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/.test(line);
}

/**
 * 把模板拆成**稳定段**与**易变段**。
 *
 * 📌 **按「行」拆，但标题跟着它那一节走** ——
 * 一个标题管辖的那一节里只要有易变占位符，
 * 这个标题就归易变段（否则标题会留在稳定段、后面却跟着易变内容，读起来别扭）。
 *
 * 📌 **空行跟着上一行走** —— 免得拆完两段各自多出一串空行。
 *
 * ⚠️ **用户改过模板、两种占位符混在一节里时** ——
 *    含易变占位符的行整体归易变段，其余行留在稳定段。
 *    这种模板拿不到完整的缓存收益（但不会出错）。
 */
export function splitTemplate(template: string): { stable: string; volatile: string } {
  const lines = template.split('\n');

  // ── 切成一节一节（标题行开一节） ──
  const sections: Array<{ lines: string[] }> = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isHeading(line)) {
      if (current.length > 0) sections.push({ lines: current });
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) sections.push({ lines: current });

  const stableLines: string[] = [];
  const volatileLines: string[] = [];
  /** 上一行归哪一段（空行跟着它走） */
  let lastGroup: 'stable' | 'volatile' = 'stable';

  for (const section of sections) {
    const sectionHasVolatile = section.lines.some(hasVolatilePlaceholder);
    for (const line of section.lines) {
      if (line.trim() === '') {
        (lastGroup === 'volatile' ? volatileLines : stableLines).push(line);
        continue;
      }
      let group: 'stable' | 'volatile';
      if (hasVolatilePlaceholder(line)) group = 'volatile';
      else if (isHeading(line)) group = sectionHasVolatile ? 'volatile' : 'stable';
      else group = 'stable';
      (group === 'volatile' ? volatileLines : stableLines).push(line);
      lastGroup = group;
    }
  }

  return {
    stable: collapseBlankLines(stableLines.join('\n')),
    volatile: collapseBlankLines(volatileLines.join('\n')),
  };
}

/** 连续空行压成一个，两端去掉 */
function collapseBlankLines(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
 * AGENTS.md 的**章节目录**（**只在截断时才生成**）。
 *
 * 📌 **为什么要有** ——
 * 截断注入的是「**文件开头的 N 字**」，而项目指令文件往往是
 * 「前面一大段项目介绍，后面才是真正的规矩」——
 * 实测（本机 27,152 字的 AGENTS.md）：
 * 前 6,000 字只到「§1 项目是什么」的中段，
 * **§3 协作模式 / §4 默认行为 / §5 不主动做的事 一个字都没进去**。
 *
 * ⚠️ **光截断没用** —— 模型不知道后面还有规矩，就永远不会去读。
 * 📌 **目录 + 行号** 让它**能直接定位**：
 * `read_file` 支持 `offset`（行号）与 `limit`，
 * 有了「第 168 行」这个信息，模型能精确读那一节，
 * 而不是把整个文件再读一遍。
 *
 * @param raw AGENTS.md 全文
 * @returns 目录正文；**没有标题就返回空串**
 */
export function buildAgentsToc(raw: string): string {
  const lines = raw.split('\n');
  const entries: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const match = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const level = (match[1] as string).length;
    const title = match[2] as string;
    // 📌 **一级标题（文件名本身）不入目录** —— 它没有信息量
    if (level === 1) continue;
    entries.push(`${'  '.repeat(level - 2)}- ${title}（第 ${i + 1} 行）`);
  }
  if (entries.length === 0) return '';
  return [
    '### 目录（AGENTS.md 的全部章节）',
    '',
    '⚠️ 下面只注入了这个文件**开头的一部分**。',
    '要看某一节，用 `read_file` 读 "AGENTS.md" 并带上对应的 `offset`（行号）。',
    '',
    ...entries,
  ].join('\n');
}

/**
 * 把项目指令正文拼成一段（**含小标题**）。
 *
 * ⚠️ **纯函数** —— 文件读不读是另一回事（`readAgentsInstructions` 管那个）。
 */
export function formatAgentsInstructions(raw: string, maxChars: number): string {
  const text = raw.trim();
  if (text === '') return '';
  const truncated = text.length > maxChars;
  // 📌 **截断时才加目录** —— 文件不长就整份注入，加目录纯属浪费 token
  // ⚠️ **而且只在「远大于上限」时才加** ——
  //    只超一点点的话（比如 6,000 上限、7,000 字的正文），
  //    缺的那点内容不值 400 token 的目录；
  //    **砍掉一大半时模型才真的需要那张地图**。
  const toc = text.length > maxChars * 2 ? buildAgentsToc(text) : '';
  const body = truncated
    ? `${text.slice(0, maxChars)}\n\n` +
      `（⚠️ AGENTS.md 已截断 —— 这里只用了前 ${maxChars} 字，全文共 ${text.length} 字。` +
      (toc
        ? '要看后面的章节，按上面的目录用 read_file 读 "AGENTS.md" 拿对应行；'
        : '要看后面的章节，用 read_file 读 "AGENTS.md" 拿全文；') +
      '完整内容也在项目根目录的 AGENTS.md）'
    : text;
  return `## 项目指令（AGENTS.md）\n\n${toc ? `${toc}\n\n` : ''}${body}`;
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
 *
 * ⚠️ **更要命的是「不报错但不生效」** ——
 *    智谱的 Anthropic 兼容端点就属于这种：接受 `cache_control`、正常返回，
 *    但**缓存根本没生效**（`cache_read_input_tokens` 恒为 0）。
 *    这种端点只能靠 `yarn cache:probe` 测出来。
 */
export function systemMessage(text: string, cache: boolean): SystemMessage {
  if (!cache) return new SystemMessage(text);
  return new SystemMessage({
    content: [{ type: 'text', text, cache_control: CACHE_CONTROL }] as never,
  });
}

/**
 * 系统提示词消息 —— **稳定段在前、易变段在后**。
 *
 * 📌 **缓存断点只打在稳定段末尾** ——
 * Anthropic 的缓存是**前缀缓存**：
 * 断点之后的内容变了，**断点之前的那段照样能命中**。
 * 以前整套提示词是一个块、断点在末尾 → 每轮全废。
 *
 * 📌 **断点之后的内容不进缓存** —— 这是设计如此：
 * 记忆 / 检索 / 技能每轮都变，缓存它们没有意义。
 *
 * ⚠️ **端点不支持时** —— `model-stream.ts` 会把标记去掉重试
 *    （`stripCacheControl` 会把多块合成一块）。
 */
export function systemMessageParts(
  stable: string,
  volatile: string,
  cache: boolean,
): SystemMessage {
  const text = [stable, volatile].filter(Boolean).join('\n\n---\n\n');
  // 📌 **不开缓存时仍然是一整段字符串** ——
  //    拆成多块只有开缓存才有意义；
  //    不开的时候保持一个字串，行为与改动前**完全一致**
  //    （下游的测试、上下文报告、审计都按字符串读）。
  if (!cache) return new SystemMessage(text);
  // 📌 **稳定段是空的** —— 那就没有可缓存的前缀，退回一整块
  if (stable.trim() === '') return new SystemMessage(text);
  return new SystemMessage({
    content: [
      { type: 'text', text: stable, cache_control: CACHE_CONTROL },
      { type: 'text', text: volatile },
    ] as never,
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
 * 组装系统提示词 —— **拆成稳定段与易变段**。
 *
 * 📌 **稳定段**（每轮基本不变 → **缓存断点打在这里**）：
 * 人格（`SOUL.md`）+ 工具规范（`prompts/tool.md`）+ 项目指令（`AGENTS.md`）
 * + 语言指令 + 模板里不含易变占位符的那部分。
 *
 * 📌 **易变段**（每轮都变 → **放在缓存断点之后**）：
 * 日期 · 可用工具 · 技能 · 会话摘要 · 长期记忆 · 跨会话检索。
 *
 * @see splitTemplate —— 拆分的规则
 */
export function buildSystemPromptParts(ctx: PromptContext = {}): {
  stable: string;
  volatile: string;
} {
  const soul = readTextFile(personalityPath(ctx.personality)).trim();
  const system = readTextFile(join(DIRS.prompts, 'system.md')).trim();
  const tool = readToolInstructions();
  const language = languageInstruction();

  const { stable: stableTemplate, volatile: volatileTemplate } = splitTemplate(system);

  /** 稳定段的变量（**易变的一律留空** —— 留着就等于没拆） */
  const stableVars: Record<string, string> = {
    language,
    tool,
    agents: ctx.agents ?? '',
    date: '',
    tools: '',
    skills: '',
    summary: '',
    memories: '',
    retrieval: '',
  };
  /** 易变段的变量（**稳定的也带上** —— 混在一节里的模板才不会丢内容） */
  const volatileVars: Record<string, string> = {
    ...stableVars,
    date: ctx.date ?? today(),
    tools: ctx.tools ?? '（本期尚未接入工具）',
    skills: ctx.skills ?? '',
    memories: ctx.memories ?? '（暂无）',
    retrieval: ctx.retrieval ?? '',
    summary: ctx.summary ?? '',
  };

  const stableSections = [soul, renderTemplate(stableTemplate, stableVars)];
  // ⚠️ **模板没写 `{{tool}}` 也要注入** —— 否则 `tool.md` 会重新变成哑巴文件
  if (tool && !system.includes('{{tool}}')) stableSections.push(tool);
  // ⚠️ **同上** —— `SYSTEM_LANGUAGE` 不能因为模板被改过就失效
  if (language && !system.includes('{{language}}')) stableSections.push(language);

  return {
    stable: stableSections.filter(Boolean).join('\n\n---\n\n'),
    volatile: renderTemplate(volatileTemplate, volatileVars),
  };
}

/**
 * 组装系统提示词 = **人格（`SOUL.md`）+ 系统提示词（`prompts/system.md`）**。
 *
 * 📌 **这是「一整块」的版本** —— 给不看缓存的场合用
 * （上下文报告、审计、测试）。
 * 要发模型的话用 {@link buildSystemPromptParts} + {@link systemMessageParts}，
 * 那样才能把缓存断点打在稳定段上。
 *
 * 📌 **`prompts/tool.md`（工具使用规范）走 `{{tool}}` 占位符** ——
 * ⚠️ **模板里没写 `{{tool}}` 也会注入**（追加到末尾）——
 * 用户改过 `system.md` 的话，只靠占位符会让 `tool.md`
 * 又变回「写了没人读」的文件（见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 */
export function buildSystemPrompt(ctx: PromptContext = {}): string {
  const { stable, volatile } = buildSystemPromptParts(ctx);
  return [stable, volatile].filter(Boolean).join('\n\n---\n\n');
}
