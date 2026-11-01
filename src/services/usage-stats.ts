import { QueryTypes } from 'sequelize';
import { sequelize } from '../db.js';
import { logger } from '../logger.js';
import { utcToIso } from '../lib/time.js';
import { DEFAULT_TITLE } from '../lib/session-title.js';
import { aggregateUsage, monthlyUsage, type UsageSummary } from './cost.js';

/**
 * 用量统计 —— 「所有会话一共用了多少 token」与「每个会话用了多少」。
 *
 * 📌 **数据源就是 `cost_logs`** —— 每轮对话结束记一条（见 `services/cost.ts`）。
 *    所以这里**不重新估算**：统计口径 = 记账口径。
 *
 * ⚠️ **有些用量没有会话归属** —— 记忆抽取（`scope='memory'`）与
 *    检索摘要（`scope='retrieval'`）**不挂在任何会话上**（它们是全局副作用）。
 *    所以「所有会话合计」会**小于**「全库合计」，差的那部分就是这些
 *    → 单列一个 `unattributedTokens`，别让人以为算错了。
 *
 * 📌 **费用为 0 不等于免费** —— 单价表（`data/pricing.json`）没配的模型
 *    费用只能记 0（见 `cost.ts` 的 `unpricedModels`）。
 */

/** 一个会话的用量（一行） */
export interface SessionUsageRow {
  id: string;
  title: string;
  /** 消息数 */
  messageCount: number;
  /** 最后活跃时间（ISO） */
  lastActiveAt: string | null;
  /** 输入 token */
  inputTokens: number;
  /** 输出 token */
  outputTokens: number;
  /** 合计 token */
  totalTokens: number;
  /** 推理 token（全额算输出） */
  reasoningTokens: number;
  /** 命中缓存的输入 token */
  cachedTokens: number;
  /** 费用（USD） */
  costUsd: number;
  /** 记了几条 */
  entries: number;
}

/** 一个模型的用量（一行） */
export interface ModelUsageRow {
  model: string;
  entries: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** 一个用途的用量（一行） */
export interface ScopeUsageRow {
  scope: string;
  entries: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** 统计页的整体结果 */
export interface UsageStats {
  /** 全库合计（**含没有会话归属的用量**） */
  total: UsageSummary;
  /** 本月合计（**按本地时区分桶**） */
  month: UsageSummary;
  /** 会话总数 */
  sessionCount: number;
  /** ⚠️ **没有会话归属的 token**（记忆抽取 / 检索摘要） */
  unattributedTokens: number;
  /** 按会话拆（**按 token 倒序**） */
  sessions: SessionUsageRow[];
  /** 按模型拆 */
  models: ModelUsageRow[];
  /** 按用途拆 */
  scopes: ScopeUsageRow[];
}

/**
 * 取一个字符串字段（**不是字符串就当没有**）。
 *
 * ⚠️ **不要直接 `String(value)`** —— 库里冒出对象时会打印 `[object Object]`。
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 按会话拆的用量 —— **一次 SQL 出全部**（LEFT JOIN）。
 *
 * ⚠️ **没有用量的会话也在列表里**（token 为 0）——
 *    「这个会话一个字都没花」本身就是信息。
 */
export async function usageBySession(): Promise<SessionUsageRow[]> {
  try {
    const rows = await sequelize.query<Record<string, unknown>>(
      `SELECT s.id AS id,
              s.title AS title,
              s.message_count AS message_count,
              s.last_active_at AS last_active_at,
              COALESCE(SUM(c.prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(c.completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(c.prompt_tokens + c.completion_tokens), 0) AS total_tokens,
              COALESCE(SUM(c.reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(c.cached_tokens), 0) AS cached_tokens,
              COALESCE(SUM(c.cost), 0) AS cost_usd,
              COUNT(c.id) AS entries
         FROM sessions s
         LEFT JOIN cost_logs c ON c.session_id = s.id
        GROUP BY s.id
        ORDER BY total_tokens DESC, s.last_active_at DESC`,
      { type: QueryTypes.SELECT },
    );
    return rows.map((row) => ({
      id: asString(row['id']),
      title: asString(row['title']) || DEFAULT_TITLE,
      messageCount: Number(row['message_count'] ?? 0),
      lastActiveAt: utcToIso(row['last_active_at'] as string | null),
      inputTokens: Number(row['input_tokens'] ?? 0),
      outputTokens: Number(row['output_tokens'] ?? 0),
      totalTokens: Number(row['total_tokens'] ?? 0),
      reasoningTokens: Number(row['reasoning_tokens'] ?? 0),
      cachedTokens: Number(row['cached_tokens'] ?? 0),
      costUsd: Math.round(Number(row['cost_usd'] ?? 0) * 1e6) / 1e6,
      entries: Number(row['entries'] ?? 0),
    }));
  } catch (err) {
    logger.error({ err }, '按会话统计用量失败');
    return [];
  }
}

/** 按模型拆的用量 */
export async function usageByModel(): Promise<ModelUsageRow[]> {
  try {
    const rows = await sequelize.query<Record<string, unknown>>(
      `SELECT model,
              COUNT(*) AS entries,
              COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
              COALESCE(SUM(cost), 0) AS cost_usd
         FROM cost_logs
        GROUP BY model
        ORDER BY total_tokens DESC`,
      { type: QueryTypes.SELECT },
    );
    return rows.map((row) => ({
      model: asString(row['model']),
      entries: Number(row['entries'] ?? 0),
      inputTokens: Number(row['input_tokens'] ?? 0),
      outputTokens: Number(row['output_tokens'] ?? 0),
      totalTokens: Number(row['total_tokens'] ?? 0),
      costUsd: Math.round(Number(row['cost_usd'] ?? 0) * 1e6) / 1e6,
    }));
  } catch (err) {
    logger.error({ err }, '按模型统计用量失败');
    return [];
  }
}

/** 按用途拆的用量（`chat` / `summary` / `memory` / `retrieval` / `cron` …） */
export async function usageByScope(): Promise<ScopeUsageRow[]> {
  try {
    const rows = await sequelize.query<Record<string, unknown>>(
      `SELECT usage_scope AS scope,
              COUNT(*) AS entries,
              COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
              COALESCE(SUM(cost), 0) AS cost_usd
         FROM cost_logs
        GROUP BY usage_scope
        ORDER BY total_tokens DESC`,
      { type: QueryTypes.SELECT },
    );
    return rows.map((row) => ({
      scope: asString(row['scope']),
      entries: Number(row['entries'] ?? 0),
      inputTokens: Number(row['input_tokens'] ?? 0),
      outputTokens: Number(row['output_tokens'] ?? 0),
      totalTokens: Number(row['total_tokens'] ?? 0),
      costUsd: Math.round(Number(row['cost_usd'] ?? 0) * 1e6) / 1e6,
    }));
  } catch (err) {
    logger.error({ err }, '按用途统计用量失败');
    return [];
  }
}

/**
 * 一次性凑齐统计页要的所有数。
 *
 * 📌 **总用量用 `cost.ts` 的聚合** —— 口径跟 `/usage` 命令、
 *    `yarn cost:report` 一致（三个出口不能各算各的）。
 */
export async function usageStats(): Promise<UsageStats> {
  const [total, month, sessions, models, scopes] = await Promise.all([
    aggregateUsage('1 = 1', {}),
    monthlyUsage(),
    usageBySession(),
    usageByModel(),
    usageByScope(),
  ]);

  // 📌 **会话合计 vs 全库合计的差** = 没有会话归属的用量
  //    （记忆抽取 / 检索摘要 —— 它们是全局副作用，不挂在任何会话上）
  const sessionSum = sessions.reduce((sum, row) => sum + row.totalTokens, 0);
  const unattributedTokens = Math.max(0, total.totalTokens - sessionSum);

  const sessionCount = sessions.length;

  return {
    total,
    month,
    sessionCount,
    unattributedTokens,
    sessions,
    models,
    scopes,
  };
}
