import { config } from '../config.js';
import { disabledTools, needsConfirmation } from '../lib/security/policy.js';
import { getToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolSensitivity } from '../tools/types.js';

/**
 * 工具总览 —— **「我有哪些能力、哪些是危险的」**
 * （见 [12-c C1](./docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **工具池已经有十几个了** —— 用户根本记不住，
 *   「刚才那个写文件的工具叫什么」「哪些工具会弹确认」这类问题
 *   **没有出口**。
 *
 * 📌 **零 LLM 调用** —— 全部是本地元信息。
 */

/** 一个工具的概览 */
export interface ToolSummary {
  /** 工具名（模型可见的那个） */
  name: string;
  /** 来源 */
  source: string;
  /** 敏感档 */
  sensitivity: ToolSensitivity;
  /** 要不要人确认 */
  needsConfirmation: boolean;
  /** 当前是否可用（被全局开关关掉了就是不可用） */
  available: boolean;
  /** 一句话说明 */
  description: string;
  /** 参数名（**给人看个大概**） */
  params: string[];
}

/** 敏感档的中文说法 */
const SENSITIVITY_TEXT: Record<ToolSensitivity, string> = {
  low: '低',
  normal: '普通',
  high: '**高危**',
};

/** 来源的中文说法 */
const SOURCE_TEXT: Record<string, string> = {
  builtin: '内置',
  skill: '技能',
  mcp: 'MCP',
};

/** 把 description 压成一行（**长描述在清单里没法看**） */
function firstLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/** 参数名（**从 zod schema 里挖**） */
function paramsOf(tool: ToolDefinition): string[] {
  const shape = (tool.schema as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== 'object') return [];
  return Object.keys(shape);
}

/** 列出全部工具 */
export function listToolSummaries(): ToolSummary[] {
  let tools: ToolDefinition[];
  try {
    tools = getToolRegistry().list();
  } catch {
    // ⚠️ **注册表读不出来也别让命令挂掉**
    return [];
  }  const disabled = disabledTools(config);
  return tools.map((tool) => ({
    name: tool.name,
    source: SOURCE_TEXT[tool.source] ?? tool.source,
    sensitivity: tool.sensitivity,
    needsConfirmation: needsConfirmation(tool.sensitivity),
    available: tool.enabled && !disabled.has(tool.name),
    description: firstLine(tool.description),
    params: paramsOf(tool),
  }));
}

/**
 * 渲染成给人看的 Markdown。
 *
 * @param detail 指定工具名时只渲染那一个（**带完整说明**）
 */
export function renderToolReport(detail?: string): string {
  const summaries = listToolSummaries();

  if (detail) {
    const tool = summaries.find((item) => item.name === detail);
    if (!tool) {
      const names = summaries.map((item) => item.name).join('、');
      return `没有这个工具：\`${detail}\`\n\n可用的是：${names}`;
    }
    return [
      `**${tool.name}**`,
      '',
      `- 来源：${tool.source}`,
      `- 敏感档：${SENSITIVITY_TEXT[tool.sensitivity]}`,
      `- 要人确认：${tool.needsConfirmation ? '**是**' : '否'}`,
      `- 当前可用：${tool.available ? '是' : '**否（被全局开关关掉了）**'}`,
      `- 参数：${tool.params.length > 0 ? tool.params.join('、') : '（无）'}`,
      '',
      tool.description,
    ].join('\n');
  }

  const lines = [
    `**工具总览**（${summaries.length} 个 · 本轮最多给模型 ${config.MAX_TOOLS_PER_TURN} 个）`,
    '',
  ];
  for (const tool of summaries) {
    const mark = tool.available ? '' : ' ⚠️不可用';
    lines.push(
      `- \`${tool.name}\`${mark} · ${tool.source} · ${SENSITIVITY_TEXT[tool.sensitivity]} · ` +
        `${tool.needsConfirmation ? '**要确认**' : '不用确认'} —— ${tool.description}`,
    );
  }
  lines.push('', '`/tools <工具名>` 看某个工具的完整说明。');
  lines.push('', '> 📌 **「要确认」= 会弹确认卡片** —— 批准了才执行。');
  return lines.join('\n');
}
