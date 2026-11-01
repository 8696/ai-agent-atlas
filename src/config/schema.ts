import { z } from 'zod';
import { isLoopbackUrl, modelEndpointProblem } from '../lib/security/model-endpoint.js';

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
  /**
   * ⚠️ **辅助模型**（**留空 = 没有**）——
   * 记忆抽取 / 会话摘要 / 跨会话检索摘要走它。
   *
   * 📌 **为什么值得单独配一个** —— 这三件事是「脏活」：
   *   输入长、输出短、不需要多强的推理。
   *   拿主模型（尤其是开了思考的）干这些活，**钱花得最冤**。
   *   配一个便宜的小模型，这部分成本能砍一大截。
   */
  LLM_AUX_BASE_URL: z.string().optional(),
  LLM_AUX_API_KEY: z.string().optional(),
  LLM_AUX_MODEL: z.string().optional(),
  /**
   * ⚠️ **提示词缓存**（Anthropic 的 `cache_control`）——
   * 系统提示词每轮都要重复注入（AGENTS.md + 记忆 + 技能 + 工具清单），
   * 缓存命中时这部分**按打折价计费**。
   *
   * 📌 **默认关** —— 国产兼容端点未必支持，
   *    支持的话（报 400 里带 `cache_control`）会自动退回不缓存。
   */
  LLM_PROMPT_CACHE: boolFromEnv(false),
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
  TOOL_OUTPUT_MAX_CHARS: z.coerce.number().int().positive().default(6000),
  TOOL_OUTPUT_TRUNCATE: z.enum(['head', 'tail']).default('tail'),
  /**
   * ⚠️ **同一个工具连续调用几次就停**（默认 2）——
   * 模型陷入死循环时，这是唯一的刹车（见 [12-b B4](./12-b-需求-对话与编排.md)）。
   */
  SAME_TOOL_REPEAT_LIMIT: z.coerce.number().int().min(1).default(2),
  /**
   * 联网搜索后端（SearXNG 兼容，形如 `http://127.0.0.1:8888/search`）。
   * ⚠️ **只在 `WEB_SEARCH_PROVIDER=searxng` 时用**。
   */
  WEB_SEARCH_URL: z.string().optional(),
  /**
   * ⚠️ **搜索后端类型** —— `auto`（默认）/ `searxng` / `tavily` / `brave` / `duckduckgo`。
   *
   * 📌 **`auto` 的判定顺序**：
   * 配了 `WEB_SEARCH_URL` → searxng；配了 `WEB_SEARCH_API_KEY` → tavily；
   * 都没配 → **duckduckgo**（**免 key** —— 工具始终可用）。
   */
  WEB_SEARCH_PROVIDER: z.enum(['auto', 'searxng', 'tavily', 'brave', 'duckduckgo']).default('auto'),
  /** 搜索后端的 API Key（**tavily / brave 用**） */
  WEB_SEARCH_API_KEY: z.string().optional(),
  /**
   * ⚠️ **单轮 token 上限**（**0 = 不限**）——
   * 一轮里累计用掉的 token 超过这个数就收尾，不再继续调工具。
   *
   * 📌 **默认不限** —— 不擅自加限制；
   *    想要「一轮别烧太多」就把它设成一个数（比如 60000）。
   */
  MAX_TOKENS_PER_TURN: z.coerce.number().int().nonnegative().default(0),
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
  /** 每轮最多给模型几个工具（按相关度裁剪）
   *  ⚠️ **13 而不是 12** —— 2026-11-01 加了 `memory` 工具（normal 档，
   *    基础工具池 +1）→ 高危工具的名额从 3 个降到 2 个。
   *    调到 13 把高危工具的名额补回来（`memory_forget` 也在里面）。
   */
  MAX_TOOLS_PER_TURN: z.coerce.number().int().positive().default(13),
  /** 并行子代理上限 */
  SUBAGENT_MAX_CONCURRENCY: z.coerce.number().int().positive().default(3),
  /** 单个子代理的工具步数上限 */
  SUBAGENT_MAX_STEPS: z.coerce.number().int().positive().default(8),
  /**
   * ⚠️ **单个子代理的 token 上限**（**0 = 不限**）——
   * 子代理的花费**记在主会话的月度预算里**，
   * 没有这道闸的话，几个并发子代理就能把一个月的预算烧光。
   *
   * 📌 **默认不限** —— 不擅自加限制；想要一道闸就设一个数。
   */
  SUBAGENT_MAX_TOKENS: z.coerce.number().int().nonnegative().default(0),
  /**
   * ⚠️ **子代理能再派几层**（默认 2 —— 主代理 + 子代理 + 孙代理）。
   *
   * 📌 **1 = 只有主代理能派**（旧行为，防递归）；
   *    2 = 子代理还能派孙代理（「并行调研 → 汇总 → 成稿」这种三层活才做得成）。
   */
  SUBAGENT_MAX_DEPTH: z.coerce.number().int().min(1).max(3).default(2),
  /** 定时任务总开关 */
  CRON_ENABLED: boolFromEnv(true),
  /** 技能自动沉淀总开关 */
  SKILL_AUTOCREATE_ENABLED: boolFromEnv(true),
  /** ⚠️ 沉淀技能所需的**最少工具调用次数**（对齐 Hermes 的「多次工具调用才合成技能」——
   *  闲聊（0 次工具调用）不该沉淀技能）
   *  📌 **默认 4，比 `MAX_TOOL_STEPS`（5）少一档** ——
   *  两个都是 5 的时候，沉淀提问**只会在「工具预算用满」的那一刻**才触发，
   *  平时跑满 4 次工具调用就答完的复杂活反而沉淀不下来 */
  SKILL_MIN_TOOL_CALLS: z.coerce.number().int().nonnegative().default(4),
  /** 每轮最多注入几个技能（**按相关度取前 N**） */
  SKILL_TOP_K: z.coerce.number().int().positive().default(3),
  /** 注入技能说明的 token 预算（**超了就不注入下一条**） */
  SKILL_TOKEN_BUDGET: z.coerce.number().int().positive().default(2000),
  /**
   * ⚠️ **注入系统提示词的 `AGENTS.md` 字符上限**（默认 12000）——
   * 项目指令文件可能有几万字，**每轮全量注入会把上下文吃光**
   * （月度 token 预算按 20 万算，注入 6000 字就是每轮 4k token）。
   * 超了只取前面这段，并标注「已截断」——
   * **模型要后面的章节可以用 `read_file` 读 "AGENTS.md" 拿全文**。
   */
  AGENTS_MAX_CHARS: z.coerce.number().int().positive().default(6000),

  // ── 浏览器 ────────────────────────────────────────────
  /** 浏览器能力总开关（关掉就不注册 `browser` 工具） */
  BROWSER_ENABLED: boolFromEnv(true),
  /**
   * ⚠️ **浏览器允许访问的域名白名单**（逗号分隔，留空 = 不限域名）。
   *
   * 📌 留空时**仍走出网校验** —— 云元数据 / 链路本地地址照样禁。
   * 填了之后只有名单里的域名能访问（`*.example.com` 这种通配也认）。
   */
  BROWSER_ALLOWED_DOMAINS: z.string().optional(),

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

  // ── 模型：配了模型就得有端点 ──
  if (env.LLM_MODEL) {
    if (!env.LLM_BASE_URL) {
      problems.push('配了 LLM_MODEL 但缺 LLM_BASE_URL');
    } else {
      // ⚠️ **本地端点免 API Key** —— 本地模型没有 Key 这回事
      //    （见 [12-a A3](./12-a-需求-应用外壳与上下文.md)）
      if (!env.LLM_API_KEY && !isLoopbackUrl(env.LLM_BASE_URL)) {
        problems.push(
          '配了 LLM_MODEL 但缺 LLM_API_KEY（本地端点 http://127.0.0.1:… 可以不要 Key）',
        );
      }
      // ⚠️ **端点指向云元数据 / 链路本地地址 → 启动即报错**
      const endpointProblem = modelEndpointProblem(env.LLM_BASE_URL);
      if (endpointProblem) problems.push(`LLM_BASE_URL 不合法：${endpointProblem}`);
    }
  }
  // 备用模型：三项要么都给，要么都不给
  const fb = [env.LLM_FALLBACK_MODEL, env.LLM_FALLBACK_BASE_URL, env.LLM_FALLBACK_API_KEY];
  if (fb.some(Boolean) && !(fb[0] && fb[1])) {
    problems.push('备用模型（LLM_FALLBACK_MODEL / _BASE_URL）要么都给，要么都不给');
  } else if (fb[0] && fb[1]) {
    // ⚠️ **备用模型也要过端点校验** —— 别让兜底变成后门
    const fallbackProblem = modelEndpointProblem(env.LLM_FALLBACK_BASE_URL);
    if (fallbackProblem) problems.push(`LLM_FALLBACK_BASE_URL 不合法：${fallbackProblem}`);
    if (!env.LLM_FALLBACK_API_KEY && !isLoopbackUrl(env.LLM_FALLBACK_BASE_URL)) {
      problems.push('备用模型缺 LLM_FALLBACK_API_KEY（本地端点可以不要 Key）');
    }
  }

  // 辅助模型：三项要么都给，要么都不给（**留空 = 走主模型**）
  const aux = [env.LLM_AUX_MODEL, env.LLM_AUX_BASE_URL, env.LLM_AUX_API_KEY];
  if (aux.some(Boolean) && !(aux[0] && aux[1])) {
    problems.push('辅助模型（LLM_AUX_MODEL / LLM_AUX_BASE_URL）要么都给，要么都不给');
  } else if (aux[0] && aux[1]) {
    // ⚠️ **辅助模型也要过端点校验** —— 别让它变成一条绕过闸的旁路
    const auxProblem = modelEndpointProblem(env.LLM_AUX_BASE_URL);
    if (auxProblem) problems.push(`LLM_AUX_BASE_URL 不合法：${auxProblem}`);
    if (!env.LLM_AUX_API_KEY && !isLoopbackUrl(env.LLM_AUX_BASE_URL)) {
      problems.push('辅助模型缺 LLM_AUX_API_KEY（本地端点可以不要 Key）');
    }
  }

  return problems;
}
