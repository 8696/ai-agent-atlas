import 'dotenv/config';
import { z } from 'zod';

/**
 * 环境变量契约 —— **唯一真源**。
 *
 * 「哪个 key 该存在、哪个该删」只看这个 schema：
 * - schema 里有 → `.env` 和 `.env.example` 都必须有
 * - schema 里没有 → 两个文件都不能有（那是死 key）
 *
 * ⚠️ 改完记得跑 `yarn env:sync`（同步）/ `yarn env:check`（只校验）。
 */

/** ⚠️ `z.coerce.boolean()` 会把字符串 "false" 当成 true（Boolean("false") === true），
 *  必须自己处理。 */
const boolFromEnv = (defaultValue: boolean) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' ? v.trim().toLowerCase() === 'true' : v),
      z.boolean(),
    )
    .default(defaultValue);

export const envSchema = z.object({
  // ── 服务 ──────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  /** ⚠️ 默认只听本机。要局域网访问再改（改了要在 UI 上提示风险）。 */
  HOST: z.string().default('127.0.0.1'),

  // ── 存储 ──────────────────────────────────────────────
  DATABASE_PATH: z.string().default('data/atlas.db'),
  VECTOR_DB_PATH: z.string().default('data/vectors.db'),
  WORKSPACE_ROOT: z.string().default('data/workspace'),

  // ── 模型（平台默认） ─────────────────────────────────
  LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),

  // ── 安全 ──────────────────────────────────────────────
  /** ⚠️ 不配则启动失败（不许用默认密钥）。 */
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 位'),
  /** ⚠️ 不配则**不能保存模型 API Key**（不降级成明文）。 */
  CONFIG_ENCRYPTION_KEY: z.string().optional(),
  /** 允许 HTTP 工具指向私网 / 回环（默认禁止）。 */
  ALLOW_PRIVATE_EGRESS: boolFromEnv(false),

  // ── 预算 ──────────────────────────────────────────────
  DEFAULT_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  COST_BUDGET_BLOCK: boolFromEnv(false),

  // ── 日志 ──────────────────────────────────────────────
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`\n[Atlas] 环境变量校验失败：\n${detail}\n`);
    console.error('参考 .env.example；改完再启动。\n');
    process.exit(1);
  }
  return parsed.data;
}

export const config: Env = loadEnv();
