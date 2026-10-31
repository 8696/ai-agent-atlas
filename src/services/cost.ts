import { existsSync, readFileSync, statSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { QueryTypes } from 'sequelize';
import { config } from '../config.js';
import { FILES } from '../config/paths.js';
import { logger } from '../logger.js';
import { sequelize } from '../db.js';
import { monthStartUtcString, utcNow } from '../lib/time.js';
import { CostLog, type UsageScope } from '../models/cost-log.model.js';

/**
 * 成本记账与预算闸 —— 见 [12-d D4](../docs/12-d-需求-记忆与配置.md)。
 *
 * 📌 **每轮结束立刻记账** —— token 用量取自模型返回的 `usage`。
 * ⚠️ **不做成本分析报表** —— 本地单用户靠 provider 侧的账单就够了；
 * 但**记账必须留**（预算闸的地基）。
 */

/** 单价（USD / 每 100 万 token） */
export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
}

/** 单价表 */
export interface PricingTable {
  models: Record<string, PricingEntry>;
}

/** 单价表缓存（**按 mtime 失效** —— 改完文件立刻生效，不用重启） */
let pricingCache: { mtimeMs: number; table: PricingTable } | undefined;

/**
 * 读单价表。
 *
 * ⚠️ **读不到就当空表** —— 单价没配只影响费用数字，不影响 token 记账。
 */
export function loadPricing(): PricingTable {
  const path = FILES.pricing;
  try {
    if (!existsSync(path)) return { models: {} };
    const mtimeMs = statSync(path).mtimeMs;
    if (pricingCache && pricingCache.mtimeMs === mtimeMs) return pricingCache.table;

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PricingTable>;
    const models: Record<string, PricingEntry> = {};
    for (const [name, value] of Object.entries(parsed.models ?? {})) {
      const entry = value as Partial<PricingEntry>;
      models[name] = {
        inputPer1M: Number(entry.inputPer1M ?? 0),
        outputPer1M: Number(entry.outputPer1M ?? 0),
      };
    }
    const table: PricingTable = { models };
    pricingCache = { mtimeMs, table };
    return table;
  } catch (err) {
    logger.warn({ err, path }, '单价表读不了 —— 只记 token 数，不算费用');
    return { models: {} };
  }
}

/** 测试用：清掉单价缓存 */
export function resetPricingCache(): void {
  pricingCache = undefined;
}

/** 算一次调用的费用（USD） */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: PricingTable = loadPricing(),
): number {
  const entry = pricing.models[model];
  if (!entry) return 0;
  const cost =
    (inputTokens / 1_000_000) * entry.inputPer1M + (outputTokens / 1_000_000) * entry.outputPer1M;
  // ⚠️ **保留 6 位小数** —— 浮点尾数留着会显示成一串噪声
  return Math.round(cost * 1e6) / 1e6;
}

/** 一次模型调用的用量（**拆到能记账的粒度**） */
export interface ModelUsage {
  /** 输入 token */
  inputTokens: number;
  /** 输出 token（**含推理 token**） */
  outputTokens: number;
  /** 推理 token（**全额算输出**） */
  reasoningTokens: number;
  /** 命中缓存的输入 token */
  cachedTokens: number;
}

/**
 * 从模型回复里取用量（**各家的 `usage` 字段位置不一样**）。
 *
 * 📌 **只认 `usage_metadata`** —— LangChain 已经把 Anthropic / OpenAI
 * 两边的字段归一化过了（`input_tokens` / `output_tokens`）。
 */
export function usageOf(reply: unknown): ModelUsage {
  const empty: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
  };
  const raw = (reply as { usage_metadata?: unknown } | null)?.usage_metadata;
  if (!raw || typeof raw !== 'object') return empty;
  const meta = raw as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_token_details?: unknown;
    output_token_details?: unknown;
  };

  const inputDetails =
    meta.input_token_details && typeof meta.input_token_details === 'object'
      ? (meta.input_token_details as { cache_read?: unknown; cache_creation?: unknown })
      : {};
  const outputDetails =
    meta.output_token_details && typeof meta.output_token_details === 'object'
      ? (meta.output_token_details as { reasoning?: unknown })
      : {};

  const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

  return {
    inputTokens: number(meta.input_tokens),
    outputTokens: number(meta.output_tokens),
    reasoningTokens: number(outputDetails.reasoning),
    cachedTokens: number(inputDetails.cache_read) + number(inputDetails.cache_creation),
  };
}

/** 记一条用量 */
export interface UsageInput {
  /** 所属会话 */
  sessionId?: string | null | undefined;
  /** 发起这次调用的 assistant 消息 id */
  messageId?: string | null | undefined;
  /** 用途 */
  scope: UsageScope;
  /** 模型名 */
  model: string;
  /** 供应商（**默认 anthropic** —— 本期只有一个兼容适配器） */
  provider?: string | undefined;
  /** 输入 token */
  inputTokens: number;
  /** 输出 token（**推理 token 全额算输出**） */
  outputTokens: number;
  /** 推理 token */
  reasoningTokens?: number | undefined;
  /** 命中缓存的输入 token */
  cachedTokens?: number | undefined;
}

/**
 * 记一条用量。
 *
 * ⚠️ **失败只记日志，不打断主流程** —— 记账挂了不该让对话失败。
 */
export async function recordUsage(input: UsageInput): Promise<void> {
  try {
    await CostLog.create({
      id: nanoid(),
      session_id: input.sessionId ?? null,
      message_id: input.messageId ?? null,
      provider: input.provider ?? 'anthropic',
      model: input.model,
      usage_scope: input.scope,
      prompt_tokens: input.inputTokens,
      completion_tokens: input.outputTokens,
      reasoning_tokens: input.reasoningTokens ?? 0,
      cached_tokens: input.cachedTokens ?? 0,
      cost: estimateCost(input.model, input.inputTokens, input.outputTokens),
      created_at: utcNow(),
    });
  } catch (err) {
    logger.error({ err, scope: input.scope }, '成本记账失败');
  }
}

/** 一段用量的汇总 */
export interface UsageSummary {
  /** 输入 token */
  inputTokens: number;
  /** 输出 token */
  outputTokens: number;
  /** 总 token */
  totalTokens: number;
  /** 推理 token（**全额算输出**） */
  reasoningTokens: number;
  /** 命中缓存的输入 token */
  cachedTokens: number;
  /** 费用（USD） */
  costUsd: number;
  /** 记了几条 */
  entries: number;
}

/** 本月用量（**按本地时区分桶**） */
export async function monthlyUsage(now: Date = new Date()): Promise<UsageSummary> {
  const since = monthStartUtcString(config.TIMEZONE, now);
  return aggregateUsage(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
            COALESCE(SUM(completion_tokens), 0) AS output_tokens,
            COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(cost), 0) AS cost_usd,
            COUNT(*) AS entries
       FROM cost_logs
      WHERE created_at >= :since`,
    { since },
  );
}

/** 一个会话的用量 */
export async function sessionUsage(sessionId: string): Promise<UsageSummary> {
  return aggregateUsage(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
            COALESCE(SUM(completion_tokens), 0) AS output_tokens,
            COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(cost), 0) AS cost_usd,
            COUNT(*) AS entries
       FROM cost_logs
      WHERE session_id = :sessionId`,
    { sessionId },
  );
}

/** 跑一条汇总查询 */
async function aggregateUsage(
  sql: string,
  replacements: Record<string, unknown>,
): Promise<UsageSummary> {
  try {
    const rows = await sequelize.query<Array<Record<string, unknown>>>(sql, {
      replacements,
      type: QueryTypes.SELECT,
    });
    const row = (rows[0] ?? {}) as Record<string, unknown>;
    return {
      inputTokens: Number(row['input_tokens'] ?? 0),
      outputTokens: Number(row['output_tokens'] ?? 0),
      totalTokens: Number(row['total_tokens'] ?? 0),
      reasoningTokens: Number(row['reasoning_tokens'] ?? 0),
      cachedTokens: Number(row['cached_tokens'] ?? 0),
      costUsd: Math.round(Number(row['cost_usd'] ?? 0) * 1e6) / 1e6,
      entries: Number(row['entries'] ?? 0),
    };
  } catch (err) {
    logger.error({ err }, '统计用量失败');
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      entries: 0,
    };
  }
}

/** 预算状态 */
export interface BudgetStatus {
  /** 本月已用 token */
  used: number;
  /** 月度预算 */
  budget: number;
  /** 用量占比（0 ~ n） */
  ratio: number;
  /** 超过告警线了 */
  warn: boolean;
  /** 超过预算了 */
  over: boolean;
  /** 要硬拦 */
  blocked: boolean;
}

/**
 * 预算闸的状态。
 *
 * ⚠️ **超预算默认只告警不拦截** —— `COST_BUDGET_BLOCK=true` 才拦。
 */
export async function checkBudget(now: Date = new Date()): Promise<BudgetStatus> {
  const usage = await monthlyUsage(now);
  const budget = config.MONTHLY_TOKEN_BUDGET;
  const ratio = budget > 0 ? usage.totalTokens / budget : 0;
  const over = usage.totalTokens > budget;
  return {
    used: usage.totalTokens,
    budget,
    ratio,
    warn: ratio >= config.WARN_RATIO,
    over,
    blocked: over && config.COST_BUDGET_BLOCK,
  };
}

/** 预算告警的一句话（**给对话里回一句提示**） */
export function budgetWarningText(status: BudgetStatus): string {
  const percent = Math.round(status.ratio * 100);
  return `本月 token 已用 ${status.used} / ${status.budget}（${percent}%）—— 超过 ${Math.round(
    config.WARN_RATIO * 100,
  )}% 告警线。`;
}
