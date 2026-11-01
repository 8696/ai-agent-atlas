import { QueryTypes } from 'sequelize';
import { sequelize } from '../db.js';
import { logger } from '../logger.js';
import { createChatModel, resolveModel } from './model.js';
import { recordUsage, usageOf } from './cost.js';
import { probeFts, searchMemory, searchMessages, ensureFtsTables } from '../lib/fts.js';
import { MEMORY_FILES } from './memory/types.js';
import { readMemory, ensureMemoryIndexFresh } from './memory/store.js';

/**
 * 跨会话检索 —— **FTS5 全文索引 + LLM 摘要**
 * （见 [12-d D3](../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **命中内容交给 LLM 摘要成一段** —— 不是全量塞进上下文
 * （这是 Hermes「FTS5 检索 + LLM 摘要」的标准做法）。
 *
 * ⚠️ **FTS5 不可用 → 退回「时间倒序」** —— 功能少一半但**不影响对话**。
 */

/** 一条命中 */
export interface SearchHit {
  /** 命中的是对话内容还是记忆 */
  kind: 'message' | 'memory';
  /** 所属会话（记忆没有） */
  sessionId: string | null;
  /** 所属消息（记忆没有） */
  messageId: string | null;
  /** 一句话标题（**会话标题 / 记忆条目标题**） */
  title: string;
  /** 摘要片段 */
  snippet: string;
}

/** 检索结果 */
export interface SearchResult {
  hits: SearchHit[];
  /** 是不是走了降级路径 */
  degraded: boolean;
  /** 降级原因（**给人看**） */
  reason?: string;
}

/** 每类最多取几条 */
const DEFAULT_TOP_K = 5;

/** 片段长度 */
const SNIPPET_MAX = 240;

/** 截一段做片段 */
function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat;
}

/**
 * 降级检索 —— **时间倒序取最近 N 条**。
 *
 * ⚠️ **不按内容匹配** —— FTS5 不可用时我们没有全文索引，
 * 只能退而求其次（功能少一半，但对话照常）。
 */
async function recentMessages(limit: number): Promise<SearchHit[]> {
  const rows = await sequelize.query<{
    content: string;
    session_id: string;
    id: string;
    title: string;
  }>(
    `SELECT m.content AS content, m.session_id AS session_id, m.id AS id, s.title AS title
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
      WHERE m.role IN ('user', 'assistant')
      ORDER BY m.created_at DESC
      LIMIT :limit`,
    { replacements: { limit }, type: QueryTypes.SELECT },
  );
  return rows.map((row) => ({
    kind: 'message' as const,
    sessionId: row.session_id,
    messageId: row.id,
    title: row.title || '（无标题会话）',
    snippet: snippetOf(row.content),
  }));
}

/**
 * 检索 —— **跨会话内容 + 记忆**。
 *
 * @param query 用户的问题
 * @param options.topK 每类取几条（默认 5）
 */
export async function searchAll(
  query: string,
  options: { topK?: number } = {},
): Promise<SearchResult> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], degraded: false };

  const probe = await probeFts();
  if (!probe.available) {
    const hits = await recentMessages(topK);
    return {
      hits,
      degraded: true,
      reason: probe.reason ?? 'FTS5 不可用，已退回时间倒序',
    };
  }

  // 📌 **索引表可能还没建**（比如 CLI 直接跑，没经过启动流程）——
  //    建表是幂等的，顺手建一次
  try {
    await ensureFtsTables();
  } catch (err) {
    logger.warn({ err }, '建 FTS 索引表失败 —— 退回时间倒序');
    const hits = await recentMessages(topK);
    return { hits, degraded: true, reason: 'FTS 索引表建不了' };
  }

  const hits: SearchHit[] = [];

  try {
    const messageHits = await searchMessages(trimmed, topK);
    for (const hit of messageHits) {
      hits.push({
        kind: 'message',
        sessionId: hit.sessionId,
        messageId: hit.messageId,
        title: '历史对话',
        snippet: snippetOf(hit.content),
      });
    }
  } catch (err) {
    logger.warn({ err }, 'FTS 检索消息失败');
  }

  try {
    // 📌 **索引过期先重建** —— 记忆在文件里，人手改过就要跟着走
    //    （见 [12-d D3](../docs/12-d-需求-记忆与配置.md)）
    await ensureMemoryIndexFresh();
    const memoryHits = await searchMemory(trimmed, topK);
    for (const hit of memoryHits) {
      hits.push({
        kind: 'memory',
        sessionId: null,
        messageId: null,
        title: `记忆 · ${hit.name}`,
        snippet: snippetOf(hit.body),
      });
    }
  } catch (err) {
    logger.warn({ err }, 'FTS 检索记忆失败');
  }

  return { hits, degraded: false };
}

/**
 * 命中内容 → **一段摘要**（LLM）。
 *
 * ⚠️ **没命中就不调模型** —— 零命中时没有任何理由花钱。
 */
export async function summarizeHits(query: string, hits: SearchHit[]): Promise<string> {
  if (hits.length === 0) return '';
  const model = resolveModel();
  if (!model) return '';

  const lines = hits.map((hit, index) => `${index + 1}. [${hit.title}] ${hit.snippet}`);

  try {
    const chat = await createChatModel(model);
    const reply = await chat.invoke([
      {
        role: 'system',
        content:
          '把检索到的历史片段压成**一段**简短的背景说明，回答用户可能关心的问题。' +
          '只写片段里确实有的内容，不要编。**没有相关内容就说「没有找到相关历史」。**',
      },
      {
        role: 'user',
        content: `用户的问题：${query}\n\n检索到的片段：\n${lines.join('\n')}`,
      },
    ] as never);
    const text = typeof reply.content === 'string' ? reply.content : '';

    // 📌 **检索摘要的花费单独记一条**（`usage_scope='retrieval'`）
    const meta = usageOf(reply);
    if (meta.inputTokens > 0 || meta.outputTokens > 0) {
      void recordUsage({
        sessionId: null,
        messageId: null,
        scope: 'retrieval',
        model: model.name,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        reasoningTokens: meta.reasoningTokens,
        cachedTokens: meta.cachedTokens,
      });
    }

    return text.trim();
  } catch (err) {
    logger.warn({ err }, '检索结果摘要失败 —— 跳过这一段');
    return '';
  }
}

/**
 * 组装注入系统提示词的「历史检索结果」段。
 *
 * 📌 **排在记忆段后面** —— 记忆是「偏好」，检索是「当时的事实」。
 * ⚠️ **检索失败不打断对话** —— 拿不到就当没有。
 */
export async function buildRetrievalSection(query: string): Promise<string> {
  if (!query.trim()) return '';
  const { hits, degraded } = await searchAll(query);
  if (hits.length === 0) return '';

  const summary = await summarizeHits(query, hits);
  if (!summary) return '';

  const label = degraded ? '历史检索结果（**全文索引不可用，以下按时间倒序**）' : '历史检索结果';
  return `## ${label}\n\n${summary}`;
}

/** 记忆条目的检索视图（**CLI 用**） */
export function memoryEntriesForIndex(): Array<{ file: string; name: string; body: string }> {
  const out: Array<{ file: string; name: string; body: string }> = [];
  for (const file of MEMORY_FILES) {
    for (const entry of readMemory(file).entries) {
      out.push({ file, name: entry.name, body: entry.body });
    }
  }
  return out;
}
