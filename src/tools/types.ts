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
  /**
   * ⚠️ **当前是第几层代理**（0 = 主代理，1 = 子代理，2 = 孙代理）。
   *
   * 📌 **子代理靠它决定「还能不能再派」** ——
   *    深度上限是 `SUBAGENT_MAX_DEPTH`（见 [12-b B10](./docs/12-b-需求-对话与编排.md)）。
   */
  depth?: number | undefined;
}

/** 工具执行结果 */
export interface ToolResult {
  /** 成功还是失败（**失败不算异常** —— 异常转成错误文本回灌给模型） */
  ok: boolean;
  /** 给模型看的正文（**会被截断**） */
  output: string;
  /**
   * ⚠️ **给模型看的正文（可选）** —— 不给就用 `output`。
   *
   * 📌 **为什么分两个** ——
   * 「给用户看的」和「给模型看的」可以不是同一份：
   * 工具卡片上给人看全文（用户想看看到底读到了什么），
   * 送模型的可以是它的截断版（**上下文是按 token 算钱的**）。
   *
   * ⚠️ **现在真实用量下用不上** ——
   *    实测 22 次真实工具调用的输出合计只有 3,151 字符。
   *    这是给「将来某个工具开始返回大块内容」留的闸门。
   */
  modelOutput?: string | undefined;
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
  /**
   * ⚠️ **触发关键词** —— 用户的话里出现这些词时，**这个工具必须留在工具池里**。
   *
   * 📌 **为什么需要它** —— 工具池按相关度裁剪时，
   *    **高危工具只剩一两个名额**（低/普通档全留），
   *    而中文查询与中文描述的相关度**噪声很大**：
   *    「跑一下测试」会把 `execute_code` 排到 `shell` 前面
   *    （「跑一」命中了「跑一段 JavaScript」，却匹配不上「执行一条 shell 命令」），
   *    于是**模型根本看不见 `shell`** —— 表现就是「Agent 有时候突然不听话」。
   *
   * 📌 **命中即强制保留** —— 不参与名额竞争。
   *    ASCII 关键词按**词边界**匹配（`ls` 不会命中 `list`）；
   *    中文关键词按**子串**匹配。
   */
  keywords?: string[] | undefined;
  /**
   * ⚠️ **组合关键词** —— **每一组都要命中**（组内任一即可）才算强制保留。
   *
   * 📌 **给危险工具用** —— 光看「删」会把「把那条**记忆**删掉」也带出
   *    `delete_path`（用户想删记忆，模型却看见了删文件的工具）。
   *    所以 `delete_path` 要「删 **且** 文件」、
   *    `memory_forget` 要「记忆 **且** 删/忘」。
   */
  keywordGroups?: string[][] | undefined;
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
