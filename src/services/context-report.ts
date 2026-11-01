import { join } from 'node:path';
import { config } from '../config.js';
import { DIRS } from '../config/paths.js';
import { estimateTokens } from '../lib/tokens.js';
import { buildSkillSection } from '../skills/inject.js';
import { getToolRegistry } from '../tools/registry.js';
import { buildMemorySection, memoryUsageHeader } from './memory/inject.js';
import {
  languageInstruction,
  personalityPath,
  readAgentsInstructions,
  readTextFile,
  readToolInstructions,
} from './prompt.js';
import { searchAll } from './search.js';
import { loadSessionMessages } from './session-summary.js';

/**
 * 上下文构成报告 —— **「这一轮到底给模型发了什么」**
 * （见 [12-a A4](./docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **上下文是隐形的** —— 人格、项目指令、长期记忆、技能、
 *    跨会话检索、会话摘要……六段东西每轮都塞进系统提示词，
 *    但**界面上一个字都看不见**。
 *    于是「它怎么知道这个的」「为什么它忘了我说过的话」
 *    这类问题**没有任何手段能查**。
 *
 * 📌 **这份报告零 LLM 调用** —— 检索只查 FTS 命中，
 *    **不调模型做摘要**（那要花钱，斜杠命令不能花钱）。
 */

/** 报告里的一段 */
export interface ContextSection {
  /** 段名（给人看的） */
  name: string;
  /** 来源（文件 / 机制） */
  source: string;
  /** 字符数 */
  chars: number;
  /** token 估算 */
  tokens: number;
  /** 被截断了 */
  truncated: boolean;
  /** 补充说明（为什么在 / 为什么不在） */
  note?: string | undefined;
}

/** 工具池的情况 */
export interface ContextToolInfo {
  /** 注册表里一共多少个工具 */
  pool: number;
  /** 这一轮会裁到多少个（`MAX_TOOLS_PER_TURN`） */
  limit: number;
  /** 工具名 */
  names: string[];
}

/** 会话历史的规模 */
export interface ContextHistoryInfo {
  /** 消息条数 */
  messages: number;
  /** 正文字符数 */
  chars: number;
  /** token 估算 */
  tokens: number;
  /** 摘要的字符数（**边界之前折成的那一段**） */
  summaryChars: number;
}

/** 一份上下文构成报告 */
export interface ContextReport {
  /** 固定的注入段（**每轮都有**） */
  sections: ContextSection[];
  /** 跟当前问题相关的动态段（**只有带问题才有**） */
  dynamic: ContextSection[];
  /** 工具池 */
  tools: ContextToolInfo;
  /** 历史规模 */
  history: ContextHistoryInfo;
  /** 这次查的问题（**空 = 只看固定段**） */
  query: string;
}

/** 造一段 */
function section(
  name: string,
  source: string,
  text: string,
  options: { truncated?: boolean; note?: string } = {},
): ContextSection {
  return {
    name,
    source,
    chars: text.length,
    tokens: estimateTokens(text),
    truncated: options.truncated ?? false,
    ...(options.note ? { note: options.note } : {}),
  };
}

/**
 * 造一份上下文构成报告。
 *
 * @param options.sessionId 当前会话（**有会话才统计历史规模**）
 * @param options.query 当前问题（**给了才算动态段**）
 * @param options.personality 人格文件名（**本会话切过的**）
 */
export async function buildContextReport(options: {
  sessionId?: string | undefined;
  query?: string | undefined;
  personality?: string | undefined;
}): Promise<ContextReport> {
  const query = (options.query ?? '').trim();

  // ── 固定段（每轮都在） ──
  const soul = readTextFile(personalityPath(options.personality)).trim();
  const system = readTextFile(join(DIRS.prompts, 'system.md')).trim();
  const tool = readToolInstructions();
  const language = languageInstruction();
  const agents = readAgentsInstructions();

  const sections: ContextSection[] = [
    section('人格', options.personality ?? 'SOUL.md', soul, {
      note: soul ? '每轮注入' : '文件是空的',
    }),
    section('系统提示词', 'prompts/system.md', system),
    section('工具使用规范', 'prompts/tool.md', tool),
    section('回复语言', '.env 的 SYSTEM_LANGUAGE', language),
    section('项目指令', 'AGENTS.md', agents, {
      truncated: agents.includes('已截断'),
      note: agents.includes('已截断')
        ? `超长 —— 只注入前 ${config.AGENTS_MAX_CHARS} 字`
        : '每轮注入前一段',
    }),
  ];

  // ── 动态段（要有一个问题才算得出来） ──
  const dynamic: ContextSection[] = [];
  if (query) {
    const memories = buildMemorySection(query);
    dynamic.push(
      section('长期记忆', 'data/memory/*.md', memories, {
        note: memoriesUsageNote(),
      }),
    );

    const skills = await buildSkillSection(query);
    dynamic.push(section('技能', 'data/skills/*/SKILL.md（FTS5 匹配）', skills));

    // ⚠️ **只列命中，不调模型摘要** —— 斜杠命令不能花钱
    const hits = await searchAll(query);
    dynamic.push(
      section('跨会话检索命中', 'messages_fts + memory_fts', '', {
        note: hits.degraded
          ? `检索降级了（${hits.reason ?? 'FTS5 不可用'}）`
          : `${hits.hits.length} 条命中` +
            (hits.hits.length > 0
              ? `：${hits.hits.map((hit) => hit.title).slice(0, 3).join('、')}`
              : ''),
      }),
    );
  }

  // ── 工具池 ──
  let names: string[] = [];
  try {
    names = getToolRegistry().names();
  } catch {
    // ⚠️ **注册表读不出来也别让报告挂掉** —— 报告是给人看的
  }
  const tools: ContextToolInfo = {
    pool: names.length,
    limit: config.MAX_TOOLS_PER_TURN,
    names,
  };

  // ── 历史规模 ──
  let history: ContextHistoryInfo = { messages: 0, chars: 0, tokens: 0, summaryChars: 0 };
  if (options.sessionId) {
    try {
      const messages = await loadSessionMessages(options.sessionId);
      let chars = 0;
      for (const message of messages) {
        chars += typeof message.content === 'string' ? message.content.length : 0;
      }
      history = {
        messages: messages.length,
        chars,
        tokens: estimateTokens(
          messages
            .map((message) => (typeof message.content === 'string' ? message.content : ''))
            .join('\n'),
        ),
        summaryChars: 0,
      };
    } catch {
      // ⚠️ **统计失败不影响报告** —— 报告是给人看的，不是给机器跑的
    }
  }

  return { sections, dynamic, tools, history, query };
}

/** 记忆的用量表头（**带在注入里的那一行**） */
function memoriesUsageNote(): string {
  try {
    return memoryUsageHeader();
  } catch {
    return '';
  }
}

/**
 * 把报告渲染成给人看的 Markdown。
 *
 * 📌 **零 LLM 调用** —— 全部是本地统计。
 */
export function renderContextReport(report: ContextReport): string {
  const lines: string[] = ['**上下文构成**', ''];

  lines.push('固定段（每轮都注入）', '');
  for (const item of report.sections) {
    lines.push(
      `- **${item.name}** · ${item.source} —— ${item.chars} 字 / ≈${item.tokens} token` +
        (item.truncated ? ' · ⚠️ 已截断' : '') +
        (item.note ? ` · ${item.note}` : ''),
    );
  }

  if (report.dynamic.length > 0) {
    lines.push('', `跟这个问题有关（查询：\`${report.query}\`）`, '');
    for (const item of report.dynamic) {
      lines.push(
        `- **${item.name}** · ${item.source} —— ${item.chars} 字 / ≈${item.tokens} token` +
          (item.note ? ` · ${item.note}` : ''),
      );
    }
  }

  const fixedChars = report.sections.reduce((sum, item) => sum + item.chars, 0);
  const fixedTokens = report.sections.reduce((sum, item) => sum + item.tokens, 0);
  const dynamicChars = report.dynamic.reduce((sum, item) => sum + item.chars, 0);
  const dynamicTokens = report.dynamic.reduce((sum, item) => sum + item.tokens, 0);

  lines.push(
    '',
    '**合计**',
    '',
    `- 固定段：${fixedChars} 字 / ≈${fixedTokens} token`,
    `- 动态段：${dynamicChars} 字 / ≈${dynamicTokens} token`,
    `- 工具池：${report.tools.pool} 个，本轮最多给模型 ${report.tools.limit} 个`,
  );
  if (report.tools.names.length > 0) {
    lines.push(`- 可用工具：${report.tools.names.join('、')}`);
  }
  if (report.history.messages > 0) {
    lines.push(
      `- 会话历史：${report.history.messages} 条消息 / ${report.history.chars} 字 / ≈${report.history.tokens} token`,
    );
  }

  lines.push(
    '',
    '> 📌 **token 是估算**（中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token）—— 够看出哪一段最占地方。',
  );
  lines.push('> 📌 **跨会话检索这里只列命中，不做摘要** —— 摘要要调模型，斜杠命令不花钱。');
  return lines.join('\n');
}
