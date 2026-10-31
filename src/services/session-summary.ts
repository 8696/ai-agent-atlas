import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { join } from 'node:path';
import { config } from '../config.js';
import { DIRS } from '../config/paths.js';
import { logger } from '../logger.js';
import { estimateTokens } from '../lib/tokens.js';
import { Session } from '../models/session.model.js';
import { Message } from '../models/message.model.js';
import { createChatModel, resolveModel } from './model.js';
import { recordUsage, usageOf } from './cost.js';
import { messageText } from './chat-messages.js';
import { readTextFile } from './prompt.js';

/**
 * 短期记忆 —— **会话摘要与压缩**（见 [12-d D1](../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **两层**：
 * - **消息历史**（`messages` 表）—— 展示与统计
 * - **图状态**（`graph_checkpoints`）—— 继续跑
 *
 * ⚠️ **边界之前不再喂原文** —— 否则「原文 + 摘要」两种说法并存，
 * 模型会自己挑一个（还不一定是新的那个）。
 *
 * ⚠️ **手动压缩（`/compress`）与自动压缩走同一个函数** ——
 * 不是两条代码路径（改一处漏一处是迟早的事）。
 */

/** 摘要状态 */
export interface SummaryState {
  /** 摘要正文（**没有摘要时是空串**） */
  summary: string;
  /** 摘要覆盖到哪条消息为止（**消息 id**） */
  boundary: string | null;
  /** 兜底：折掉了几条（**消息 id 对不上时按条数裁**） */
  count: number;
}

/** 会话元数据里存摘要边界的地方 */
interface SessionMetadata {
  summary_boundary?: string;
  summary_count?: number;
}

/**
 * 从库里读会话的对话（**用户 + 助手**）。
 *
 * 📌 **带 message id** —— 摘要边界靠 id 定位（按下标裁会裁错）。
 */
export async function loadSessionMessages(sessionId: string): Promise<BaseMessage[]> {
  const rows = await Message.findAll({
    where: { session_id: sessionId, role: ['user', 'assistant'] },
    order: [['created_at', 'ASC']],
  });
  return rows.map((row) => {
    const text = row.content ?? '';
    if (row.role === 'user') return new HumanMessage({ content: text, id: row.id });
    return new AIMessage({ content: text, id: row.id });
  });
}

/** 读会话的摘要状态 */
export async function loadSummary(sessionId: string): Promise<SummaryState> {
  const session = await Session.findByPk(sessionId);
  if (!session) return { summary: '', boundary: null, count: 0 };

  let metadata: SessionMetadata = {};
  if (session.metadata) {
    try {
      metadata = JSON.parse(session.metadata) as SessionMetadata;
    } catch {
      metadata = {};
    }
  }

  return {
    summary: session.summary ?? '',
    boundary: metadata.summary_boundary ?? null,
    count: metadata.summary_count ?? 0,
  };
}

/** 把摘要状态写回会话 */
async function saveSummary(
  sessionId: string,
  summary: string,
  boundary: string | null,
  count: number,
): Promise<void> {
  const session = await Session.findByPk(sessionId);
  if (!session) return;

  let metadata: Record<string, unknown> = {};
  if (session.metadata) {
    try {
      metadata = JSON.parse(session.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  metadata['summary_boundary'] = boundary;
  metadata['summary_count'] = count;

  session.summary = summary;
  session.metadata = JSON.stringify(metadata);
  await session.save();
}

/** 消息的 token 估算 */
function tokensOf(messages: BaseMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(messageText(message));
  return total;
}

/** 最后一条用户消息的下标（**没有就返回 -1**） */
function lastUserIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.getType() === 'human') return i;
  }
  return -1;
}

/**
 * 自动压缩时**折到哪一条为止**。
 *
 * 📌 **从最旧的开始折** —— 折掉最早的那几轮，直到剩下的装得进预算。
 * ⚠️ **最后一条用户消息永远不折** —— 那是要回答的问题，不能只剩摘要。
 */
function autoCutIndex(messages: BaseMessage[], budget: number): number {
  const keepFrom = lastUserIndex(messages);
  if (keepFrom <= 0) return 0;

  let total = tokensOf(messages);
  let cut = 0;
  while (cut < keepFrom && total > budget) {
    total -= estimateTokens(messageText(messages[cut] as BaseMessage));
    cut += 1;
  }
  return cut;
}

/** 手动压缩时**折到哪一条为止**（**最后一条用户消息之前全折**） */
function manualCutIndex(messages: BaseMessage[]): number {
  const keepFrom = lastUserIndex(messages);
  if (keepFrom <= 0) return 0;
  return keepFrom;
}

/** 摘要用的系统提示词 */
function summaryPrompt(): string {
  const base = readTextFile(join(DIRS.prompts, 'summary.md')).trim();
  return `${base}

## 输出要求

- 只输出**摘要正文**，不要标题、不要前缀
- 用中文
- ⚠️ **是一份完整摘要**（重写，不是追加）`;
}

/**
 * 压缩会话 —— **自动与手动共用这一个函数**。
 *
 * @param sessionId 会话 id
 * @param messages 完整历史（**含要折掉的那几轮**）
 * @param options.manual 手动（`/compress`）—— **忽略 token 阈值，立即折**
 *
 * @returns 压缩结果（**失败不抛** —— 压缩失败不该把对话搞挂）
 */
export async function compressSession(
  sessionId: string,
  messages: BaseMessage[],
  options: { manual?: boolean } = {},
): Promise<{ ok: boolean; message: string; summary?: string; folded?: number }> {
  const cut = options.manual
    ? manualCutIndex(messages)
    : autoCutIndex(messages, config.SUMMARY_TOKEN_BUDGET);

  if (cut <= 0) {
    return {
      ok: true,
      message: options.manual ? '没有可压缩的历史（太短了）' : '当前上下文还在预算内，不用压缩',
      folded: 0,
    };
  }

  const model = resolveModel();
  if (!model) return { ok: false, message: '还没配置模型 —— 无法生成摘要' };

  const folded = messages.slice(0, cut);
  const kept = messages.slice(cut);
  const previous = await loadSummary(sessionId);

  const transcript = folded
    .map((message) => {
      const role =
        message.getType() === 'human' ? '用户' : message.getType() === 'ai' ? '助手' : '系统';
      return `${role}：${messageText(message)}`;
    })
    .join('\n');

  let summary: string;
  try {
    const chat = createChatModel(model);
    const reply = await chat.invoke([
      new SystemMessage(summaryPrompt()),
      new HumanMessage(
        [
          previous.summary ? `## 旧摘要\n${previous.summary}` : '（这是第一次压缩，没有旧摘要）',
          '',
          '## 这一轮要折掉的对话',
          '',
          transcript,
          '',
          '## 折完之后仍然保留的对话（**不要重复写进去**）',
          '',
          kept
            .map(
              (message) =>
                `${message.getType() === 'human' ? '用户' : '助手'}：${messageText(message)}`,
            )
            .join('\n') || '（无）',
        ].join('\n'),
      ),
    ]);
    summary = typeof reply.content === 'string' ? reply.content.trim() : '';

    // 📌 **摘要的花费单独记一条**（`usage_scope='summary'`）——
    //    它也是模型调用，混进对话账里就看不出「摘要花了多少」
    const meta = usageOf(reply);
    if (meta.inputTokens > 0 || meta.outputTokens > 0) {
      void recordUsage({
        sessionId,
        messageId: null,
        scope: 'summary',
        model: model.name,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        reasoningTokens: meta.reasoningTokens,
        cachedTokens: meta.cachedTokens,
      });
    }
  } catch (err) {
    logger.warn({ err, sessionId }, '生成会话摘要失败 —— 本轮不压缩');
    return {
      ok: false,
      message: `生成摘要失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!summary) return { ok: false, message: '摘要是空的 —— 本轮不压缩' };

  const lastFolded = folded.at(-1);
  const boundary = lastFolded?.id ?? null;
  await saveSummary(sessionId, summary, boundary, folded.length);

  return {
    ok: true,
    message: `已把 ${folded.length} 条早期消息折成摘要`,
    summary,
    folded: folded.length,
  };
}

/**
 * 按边界裁剪历史 —— **边界之前只剩摘要**。
 *
 * ⚠️ **按消息 id 裁** —— 「重新生成」会删掉中间的消息，
 * 按下标裁会裁错位置。id 对不上时退回到「按条数裁」。
 */
export function trimByBoundary(messages: BaseMessage[], state: SummaryState): BaseMessage[] {
  if (!state.summary) return messages;

  if (state.boundary) {
    const index = messages.findIndex((message) => message.id === state.boundary);
    if (index >= 0) return messages.slice(index + 1);
  }

  if (state.count > 0 && state.count < messages.length) {
    return messages.slice(state.count);
  }
  return messages;
}

/**
 * **截断** —— 摘要开关关掉时的降级路径（见 [12-d D1](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ⚠️ **从最旧的开始丢** —— 最后一条用户消息永远留着（那是要回答的问题）。
 * 📌 **不写摘要** —— 摘要关了就没有摘要，只有「早期的不要了」。
 */
function truncateOldest(messages: BaseMessage[], budget: number): BaseMessage[] {
  const keepFrom = lastUserIndex(messages);
  if (keepFrom <= 0) return messages;

  let total = tokensOf(messages);
  let cut = 0;
  while (cut < keepFrom && total > budget) {
    total -= estimateTokens(messageText(messages[cut] as BaseMessage));
    cut += 1;
  }
  return cut > 0 ? messages.slice(cut) : messages;
}

/**
 * 准备这一轮的上下文 —— **裁剪 + 压缩**。
 *
 * 📌 **自动压缩在这里触发** —— 超出 `SUMMARY_TOKEN_BUDGET` 就折。
 * ⚠️ **压缩失败不影响对话** —— 折不动就按原样送进去。
 */
export async function prepareSessionContext(
  sessionId: string,
  messages: BaseMessage[],
  options: { manual?: boolean } = {},
): Promise<{ messages: BaseMessage[]; summary: string; compressed: boolean }> {
  let state = await loadSummary(sessionId);

  // ── 先按已有边界裁掉 ──
  let trimmed = trimByBoundary(messages, state);

  // ── 超预算 → 压缩 ──
  let compressed = false;
  const overBudget = tokensOf(trimmed) > config.SUMMARY_TOKEN_BUDGET;

  if (options.manual) {
    // 📌 **手动压缩忽略 token 阈值** —— 立即把当前历史折成摘要
    const result = await compressSession(sessionId, trimmed, { manual: true });
    if (result.ok && result.summary) {
      state = await loadSummary(sessionId);
      trimmed = trimByBoundary(trimmed, state);
      compressed = (result.folded ?? 0) > 0;
    }
  } else if (overBudget && config.SUMMARY_ENABLED) {
    const result = await compressSession(sessionId, trimmed, { manual: false });
    if (result.ok && result.summary) {
      state = await loadSummary(sessionId);
      trimmed = trimByBoundary(trimmed, state);
      compressed = (result.folded ?? 0) > 0;
    }
  } else if (overBudget) {
    // ⚠️ **摘要开关关着 → 走「截断」而不是「摘要」**
    trimmed = truncateOldest(trimmed, config.SUMMARY_TOKEN_BUDGET);
  }

  return { messages: trimmed, summary: state.summary, compressed };
}
