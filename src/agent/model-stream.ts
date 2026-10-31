import type { BaseMessage } from '@langchain/core/messages';
import { logger } from '../logger.js';
import { createChatModel, type ResolvedModel } from '../services/model.js';

/**
 * 调模型 —— **带降级与故障转移**（见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ```
 * ① 主模型（带思考）
 *      ↓ 报「不支持思考」→ ② 主模型（关思考）
 *      ↓ 还报错        → ③ 备用模型（带思考）
 *      ↓ 还报「不支持」→ ④ 备用模型（关思考）
 *      ↓ 还报错        → 抛出去
 * ```
 *
 * ⚠️ **只在「一个内容 chunk 都还没吐出去」时才切** ——
 * 已经吐过字再换模型，用户会看到两段拼接的答案。
 *
 * 📌 **每一次尝试都重新校验端点** —— `createChatModel` 内部会做。
 */

/** 这一次用的是哪种策略（**给日志与审计看**） */
export type StreamStrategy =
  | 'primary'
  | 'primary-no-thinking'
  | 'fallback'
  | 'fallback-no-thinking';

/** 流里的一块 */
export interface ModelStreamChunk {
  /** LangGraph / LangChain 的原始 chunk */
  chunk: unknown;
  /** 真正产出这一块的模型（**记账要用它**） */
  model: ResolvedModel;
  /** 用的哪种策略 */
  strategy: StreamStrategy;
}

/** 从一块模型增量里取出思考文本（**Anthropic 把思考放在独立块里**） */
export function readReasoningDelta(chunk: { contentBlocks?: unknown }): string {
  if (!Array.isArray(chunk.contentBlocks)) return '';
  let out = '';
  for (const block of chunk.contentBlocks) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { type?: unknown; reasoning?: unknown; thinking?: unknown };
    if (record.type === 'reasoning' && typeof record.reasoning === 'string') {
      out += record.reasoning;
    } else if (record.type === 'thinking' && typeof record.thinking === 'string') {
      out += record.thinking;
    }
  }
  return out;
}

/**
 * 这一块有没有「内容」（**正文 / 思考 / 工具调用**）。
 *
 * ⚠️ **元数据块不算** —— 有些适配器先吐一个空壳块，
 * 拿它当「已经吐过字」会让故障转移失效。
 */
export function chunkHasContent(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const piece = chunk as {
    text?: unknown;
    contentBlocks?: unknown;
    tool_call_chunks?: unknown;
    tool_calls?: unknown;
  };
  if (typeof piece.text === 'string' && piece.text !== '') return true;
  if (readReasoningDelta(piece) !== '') return true;
  if (Array.isArray(piece.tool_call_chunks) && piece.tool_call_chunks.length > 0) return true;
  if (Array.isArray(piece.tool_calls) && piece.tool_calls.length > 0) return true;
  return false;
}

/**
 * 这个错是不是「模型不支持思考参数」。
 *
 * ⚠️ **宁可多降级一次** —— 降级只是关掉思考块，
 * 猜错了大不了这一轮没有思考内容，不会把对话搞坏。
 */
export function isThinkingUnsupportedError(err: unknown): boolean {
  const text = errorText(err);
  if (!text) return false;
  return /thinking|reasoning/i.test(text);
}

/** 把错误摊平成一段文本（**各家异常的形状不一样**） */
export function errorText(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const record = err as {
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    body?: unknown;
    cause?: unknown;
  };
  const parts: string[] = [];
  if (typeof record.message === 'string') parts.push(record.message);
  if (typeof record.status === 'number') parts.push(`status=${record.status}`);
  if (typeof record.statusCode === 'number') parts.push(`status=${record.statusCode}`);
  if (record.body) {
    try {
      parts.push(typeof record.body === 'string' ? record.body : JSON.stringify(record.body));
    } catch {
      // 序列化不了就算了
    }
  }
  if (record.cause) parts.push(errorText(record.cause));
  return parts.join(' · ');
}

export interface ModelStreamOptions {
  /** 主模型 */
  primary: ResolvedModel;
  /** 备用模型（**没有就是 undefined**） */
  fallback: ResolvedModel | undefined;
  /** 本轮的思考预算（0 = 关） */
  thinkingBudget: number;
  /** 上下文 */
  messages: BaseMessage[];
  /** 绑给模型的工具（**空数组 = 不绑**） */
  tools: unknown[];
  /** 客户端断开时 abort */
  signal?: AbortSignal | undefined;
  /** 切模型时的回调（**写日志 / 审计**） */
  onStrategyChange?: ((from: StreamStrategy, to: StreamStrategy, reason: string) => void) | undefined;
}

/**
 * 调模型并流式吐字 —— **带降级与故障转移**。
 *
 * ⚠️ **错误在「已经吐过内容」之后原样抛出去** —— 不切模型。
 */
export async function* streamChatModel(
  options: ModelStreamOptions,
): AsyncGenerator<ModelStreamChunk> {
  const { primary, fallback, thinkingBudget, messages, tools, signal } = options;

  let useFallback = false;
  let budget = thinkingBudget;

  for (;;) {
    const model = useFallback ? fallback : primary;
    if (!model) throw new Error('没有可用模型');

    // 📌 **策略名跟着「用哪个模型 + 关不关思考」走**
    const current: StreamStrategy = useFallback
      ? budget > 0
        ? 'fallback'
        : 'fallback-no-thinking'
      : budget > 0
        ? 'primary'
        : 'primary-no-thinking';

    let emitted = false;
    try {
      const chatModel = await createChatModel({
        ...model,
        thinkingBudget: budget,
      });
      const bound =
        tools.length > 0
          ? chatModel.bindTools(tools as never[])
          : chatModel;

      const stream = await bound.stream(messages, {
        ...(signal ? { signal } : {}),
      });

      for await (const chunk of stream as AsyncIterable<unknown>) {
        if (chunkHasContent(chunk)) emitted = true;
        yield { chunk, model, strategy: current };
      }
      return;
    } catch (err) {
      // ⚠️ **已经吐过内容就不切** —— 用户会看到两段拼接的答案
      if (emitted) throw err;

      const reason = errorText(err);

      // ── ① 供应商不支持思考 → 关掉思考重试 ──
      if (budget > 0 && isThinkingUnsupportedError(err)) {
        logger.warn(
          { model: model.name, reason: reason.slice(0, 300) },
          '模型不接受思考参数 —— 关掉思考重试',
        );
        const next: StreamStrategy = useFallback ? 'fallback-no-thinking' : 'primary-no-thinking';
        options.onStrategyChange?.(current, next, '模型不支持思考参数');
        budget = 0;
        continue;
      }

      // ── ② 主模型挂了 → 切备用 ──
      if (!useFallback && fallback) {
        logger.warn(
          { from: model.name, to: fallback.name, reason: reason.slice(0, 300) },
          '主模型调用失败 —— 切备用模型',
        );
        options.onStrategyChange?.(current, 'fallback', reason.slice(0, 300));
        useFallback = true;
        budget = fallback.thinkingBudget;
        continue;
      }

      throw err;
    }
  }
}
