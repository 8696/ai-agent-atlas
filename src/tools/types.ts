import type { z } from 'zod';

/**
 * 工具定义的统一形态 —— **内置 / Skill / MCP 三种来源长得一样**
 * （见 [12-c C1](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **来源从声明处读**（内置在代码里、Skill 在 `SKILL.md` frontmatter、
 * MCP 在 `data/mcp.json`）—— **库里没有工具表**。
 */

/** 敏感档（**决定要不要人确认**） */
export type ToolSensitivity = 'low' | 'normal' | 'high';

/** 来源 */
export type ToolSource = 'builtin' | 'skill' | 'mcp';

/**
 * 执行后端。
 *
 * - `local` —— 本地进程执行
 * - `subagent` —— 子代理也能调
 * - `none` —— **不可被子代理调用**（子代理不得绕过确认，见 [12-b B10](../docs/12-b-需求-对话与编排.md)）
 */
export type ToolExecutor = 'local' | 'subagent' | 'none';

/** 工具执行时的上下文 */
export interface ToolContext {
  /** 会话 id（写流水用） */
  sessionId?: string | undefined;
  /** 发起这次调用的 assistant 消息 id */
  messageId?: string | undefined;
  /** 客户端断开时 abort */
  signal?: AbortSignal | undefined;
  /**
   * 这次工具调用的 id（**父图恢复时不变**）。
   *
   * 📌 **子代理靠它算稳定的 thread_id** —— 重跑时不能换。
   */
  toolCallId?: string | undefined;
  /**
   * 注入检测命中的特征（**空 = 没命中**）。
   *
   * 📌 **要传给工具** —— 沙箱里的 RPC 调用要在**自己的权限闸**上再判一次，
   *    不然「注入命中 → 升档」在沙箱那条路上就是空的
   *    （见 [10 §10.7](../../docs/10-安全方案.md)）。
   */
  injectionMatches?: string[] | undefined;
}

/** 工具执行结果 */
export interface ToolResult {
  /** 成功还是失败（**失败不算异常** —— 异常转成错误文本回灌给模型） */
  ok: boolean;
  /** 给模型看的正文（**会被截断**） */
  output: string;
  /** 结构化结果（给工具卡片看） */
  data?: unknown;
  /** 失败原因（**失败要显示，不吞掉**） */
  error?: string | undefined;
  /** 输出被截断了 */
  truncated?: boolean;
  /** 截断前的原始长度 */
  originalLength?: number | undefined;
  /**
   * ⚠️ **置 false 就别再过一遍全局截断**（`TOOL_OUTPUT_MAX_CHARS`）。
   *
   * 📌 **只有「自己知道输出多大」的工具能这么做** ——
   * 比如 `read_file` 读项目指令文件（`AGENTS.md`）：
   * 它有明确的行数上限，全局截断会把「头部」截掉、只剩尾巴，
   * 模型读到的是半截文件（比读不到更糟）。
   */
  truncate?: boolean | undefined;
}

/** 一个工具定义 */
export interface ToolDefinition {
  /** 工具名（**模型可见、全局唯一**） */
  name: string;
  /** 描述 —— ⚠️ **这是给模型看的**，改它就是在「调教模型调不调它」 */
  description: string;
  /** 入参 schema（zod） */
  schema: z.ZodType;
  /** 敏感档 */
  sensitivity: ToolSensitivity;
  /** 风险说明（**确认卡片上给用户看的那句话**） */
  riskNote?: string | undefined;
  /** 来源 */
  source: ToolSource;
  /** 是否启用（**停用的不进工具池，模型看不到**） */
  enabled: boolean;
  /** 执行后端 */
  executor: ToolExecutor;
  /** 实现 */
  invoke: (args: unknown, context: ToolContext) => Promise<ToolResult>;
}

/** 敏感档排序（**用于比较**） */
export const SENSITIVITY_RANK: Record<ToolSensitivity, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

/**
 * 入参上限（**每个工具都要过**）——
 * 见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)「通用约束」。
 */
export const MAX_STRING_ARG_LENGTH = 10_000;
export const MAX_ARRAY_ARG_LENGTH = 100;
