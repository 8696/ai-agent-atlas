import { z } from 'zod';

/**
 * 环境变量契约 —— **唯一真源**。
 *
 * 「哪个 key 该存在、哪个该删」只看这个 schema：
 * - schema 里有 → `.env` 和 `.env.example` 都必须有
 * - schema 里没有 → 两个文件都不能有（那是死 key）
 *
 * ⚠️ **本文件只定义 schema，不读 `process.env`** ——
 * 这样 `scripts/sync-env.ts` 能安全地 import 它做契约校验
 * （import `src/config.ts` 会触发启动校验并 `process.exit`）。
 */

/** ⚠️ `z.coerce.boolean()` 会把字符串 "false" 当成 true（Boolean("false") === true），
 *  必须自己处理。 */
export const boolFromEnv = (defaultValue: boolean) =>
  z
    .preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() === 'true' : v), z.boolean())
    .default(defaultValue);

export const envSchema = z.object({
  // ── 服务 ──────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  /** ⚠️ 默认只听本机。改成非回环（如 0.0.0.0）时，启动日志会打红色告警：
   *  局域网内任何人都能用本 Agent 执行命令 */
  HOST: z.string().default('127.0.0.1'),

  // ── 存储 ──────────────────────────────────────────────
  DATABASE_PATH: z.string().default('data/atlas.db'),
  /** Agent 能碰到的目录根（路径沙箱的基准） */
  WORKSPACE_ROOT: z.string().default('data/workspace'),

  // ── 模型 ──────────────────────────────────────────────
  // ⚠️ **只有一个模型，纯标量** —— 一个 Base URL + 一个 Key + 一个模型标识。
  //    四家国产模型全都提供 Anthropic 兼容端点 → **只做一个 anthropic 适配器**，
  //    换供应商 = 改这三行，**不改代码**。
  /** Anthropic 兼容端点（如 https://open.bigmodel.cn/api/anthropic） */
  LLM_BASE_URL: z.string().optional(),
  /** API Key */
  LLM_API_KEY: z.string().optional(),
  /** 模型标识（如 glm-5.3） */
  LLM_MODEL: z.string().optional(),
  /** 备用模型（**留空 = 没有兜底**）—— 主模型失败时切 */
  LLM_FALLBACK_BASE_URL: z.string().optional(),
  LLM_FALLBACK_API_KEY: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),
  /** 推理预算（默认 1024 = 开，0 = 关）—— ⚠️ Anthropic 要求 `LLM_MAX_TOKENS > 预算` */
  LLM_THINKING_BUDGET: z.coerce.number().int().nonnegative().default(1024),
  /** 单次输出上限 */
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  /** 采样温度 */
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(1),
  /** ⚠️ MCP server 列表放**文件**（`data/mcp.json`）——
   *  它是列表型配置，`.env` 里只留一个路径（`.env` 全是标量，不放 JSON） */
  MCP_CONFIG_PATH: z.string().default('data/mcp.json'),

  // ── 通用配置 ──────────────────────────────────────────
  SYSTEM_LANGUAGE: z.string().default('zh-CN'),
  TIMEZONE: z.string().default('Asia/Shanghai'),
  MAX_TOOL_STEPS: z.coerce.number().int().positive().default(5),
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MULTI_TOOL_CALLS: boolFromEnv(true),
  MEMORY_ENABLED: boolFromEnv(true),
  MEMORY_RELEVANCE_ENABLED: boolFromEnv(true),
  MEMORY_TOP_K: z.coerce.number().int().positive().default(8),
  MEMORY_TOKEN_BUDGET: z.coerce.number().int().positive().default(2000),
  /** ⚠️ `MEMORY.md` 的字符上限（对齐 Hermes 的 2200）——
   *  超了不自动压缩，只报告；防文件无限膨胀 + 逼着改写而非重复追加 */
  MEMORY_MAX_CHARS: z.coerce.number().int().positive().default(2200),
  /** ⚠️ `USER.md` 的字符上限（对齐 Hermes 的 1375） */
  USER_MAX_CHARS: z.coerce.number().int().positive().default(1375),
  SUMMARY_ENABLED: boolFromEnv(true),
  SUMMARY_TOKEN_BUDGET: z.coerce.number().int().positive().default(2000),
  TOOL_OUTPUT_MAX_CHARS: z.coerce.number().int().positive().default(4000),
  TOOL_OUTPUT_TRUNCATE: z.enum(['head', 'tail']).default('tail'),
  /**
   * ⚠️ **同一个工具连续调用几次就停**（默认 2）——
   * 模型陷入死循环时，这是唯一的刹车（见 [12-b B4](./12-b-需求-对话与编排.md)）。
   */
  SAME_TOOL_REPEAT_LIMIT: z.coerce.number().int().min(1).default(2),
  /**
   * 联网搜索后端（SearXNG 兼容，形如 `http://127.0.0.1:8888/search`）。
   * ⚠️ **留空 = 不注册 `web_search` 工具** —— 模型看不到一个必然失败的工具。
   */
  WEB_SEARCH_URL: z.string().optional(),
  /** 会话保留天数（超期连同消息一起清掉；收藏的会话不清） */
  SESSION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  // ── 成本 ──────────────────────────────────────────────
  MONTHLY_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  /** 超预算是否硬拦（默认只告警） */
  COST_BUDGET_BLOCK: boolFromEnv(false),
  /** 告警比例（0~1） */
  WARN_RATIO: z.coerce.number().min(0).max(1).default(0.8),

  // ── 安全 ──────────────────────────────────────────────
  /** 允许 HTTP 工具指向私网 / 回环（默认禁止） */
  ALLOW_PRIVATE_EGRESS: boolFromEnv(false),
  /** 关掉整个 shell 能力（一键开关） */
  SHELL_ENABLED: boolFromEnv(true),
  /** none | normal | high —— 低于工具敏感档时不弹确认 */
  TOOL_CONFIRM_LEVEL: z.enum(['none', 'normal', 'high']).default('high'),

  // ── 编排 ──────────────────────────────────────────────
  /** 每轮最多给模型几个工具（按相关度裁剪） */
  MAX_TOOLS_PER_TURN: z.coerce.number().int().positive().default(12),
  /** 并行子代理上限 */
  SUBAGENT_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  /** 单个子代理的工具步数上限 */
  SUBAGENT_MAX_STEPS: z.coerce.number().int().positive().default(8),
  /** 定时任务总开关 */
  CRON_ENABLED: boolFromEnv(true),
  /** 技能自动沉淀总开关 */
  SKILL_AUTOCREATE_ENABLED: boolFromEnv(true),
  /** ⚠️ 沉淀技能所需的**最少工具调用次数**（对齐 Hermes 的 5+ 次门槛）——
   *  闲聊（0 次工具调用）不该沉淀技能 */
  SKILL_MIN_TOOL_CALLS: z.coerce.number().int().nonnegative().default(5),
  /** 每轮最多注入几个技能（**按相关度取前 N**） */
  SKILL_TOP_K: z.coerce.number().int().positive().default(3),
  /** 注入技能说明的 token 预算（**超了就不注入下一条**） */
  SKILL_TOKEN_BUDGET: z.coerce.number().int().positive().default(2000),

  // ── 日志 ──────────────────────────────────────────────
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** envSchema 声明的全部 key（**顺序 = `.env` 里的顺序**） */
export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof Env)[];

/** ⚠️ **跨字段校验**：zod 的 `superRefine` 在 `transform` 之后跑，
 *  但模型唯一性 / 备用模型指向这类约束要在解析后单独检查。 */
export function validateRelations(env: Env): string[] {
  const problems: string[] = [];

  // ── 模型：配了模型就三样都得有 ──
  if (env.LLM_MODEL) {
    if (!env.LLM_BASE_URL) problems.push('配了 LLM_MODEL 但缺 LLM_BASE_URL');
    if (!env.LLM_API_KEY) problems.push('配了 LLM_MODEL 但缺 LLM_API_KEY');
  }
  // 备用模型：三样要么都给，要么都不给
  const fb = [env.LLM_FALLBACK_MODEL, env.LLM_FALLBACK_BASE_URL, env.LLM_FALLBACK_API_KEY];
  if (fb.some(Boolean) && !fb.every(Boolean)) {
    problems.push('备用模型三项（LLM_FALLBACK_MODEL / _BASE_URL / _API_KEY）要么都给，要么都不给');
  }

  return problems;
}
