import { nanoid } from 'nanoid';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { getWriter } from '@langchain/langgraph';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { scanInjection, tightenSensitivity } from '../../lib/security/injection.js';
import { buildSystemPrompt } from '../../services/prompt.js';
import { createChatModel, resolveModel } from '../../services/model.js';
import { getToolRegistry, toLangChainTools } from '../../tools/registry.js';
import { selectTools } from '../../tools/selection.js';
import { assembleToolCalls } from '../tool-calls.js';
import { messageText } from '../../services/chat-messages.js';
import type { AtlasStateUpdate } from '../state.js';

/**
 * `plan` 节点 —— **调模型：直接答，还是调工具？**
 * （见 [12-b B3](../docs/12-b-需求-对话与编排.md) 与 [03-b §B.5.1](../docs/03-b-技术栈-后端栈.md)）。
 *
 * ⚠️ **判定交给模型** —— 不做关键词规则匹配。
 * ⚠️ **回答与工具调用在一次流里完成** —— 否则会出现
 * 「先回一句『我来查一下』再卡住」的两段式体验。
 *
 * 📌 **工具池按相关度裁剪** —— 裁剪发生在调模型之前，
 * 被裁掉的工具这一轮模型完全看不到。
 */

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

/** 最后一条用户消息（**拿它做工具裁剪的查询**） */
function lastUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.getType() === 'human') return messageText(message);
  }
  return '';
}

/** 工具清单（**给系统提示词看的**） */
function describeTools(names: string[]): string {
  if (names.length === 0) return '（本期没有可用工具）';
  return names.join('、');
}

/**
 * 计划节点。
 *
 * @param state 图状态
 * @param runnableConfig LangGraph 传进来的配置（**信号、writer 都在里面**）
 */
export async function planNode(
  state: { messages: BaseMessage[] },
  runnableConfig: { signal?: AbortSignal },
): Promise<AtlasStateUpdate> {
  const model = resolveModel();
  if (!model) {
    throw new Error('还没配置模型 —— 去改 .env 的 LLM_MODEL');
  }

  // ── 工具池裁剪 ──
  const registry = getToolRegistry();
  const enabled = registry.list().filter((tool) => tool.enabled);
  const query = lastUserText(state.messages);
  const selected = selectTools(enabled, query, config);

  // ⚠️ **用户消息过注入检测** —— 命中只告警 + 收紧工具档，不直接拒答
  //    （见 [10 §10.7](../../docs/10-安全方案.md)）
  const scan = scanInjection(query);
  if (scan.detected) {
    logger.warn({ matches: scan.matches }, '用户消息里出现疑似提示词注入 —— 工具档已收紧');
  }
  const tools = scan.detected
    ? selected.map((tool) => tightenSensitivity(tool, scan))
    : selected;

  // ── 上下文 ──
  const systemPrompt = buildSystemPrompt({
    tools: describeTools(tools.map((tool) => tool.name)),
  });
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...state.messages];

  // ── 调模型（**一次流里出字 + 出工具调用**） ──
  const chatModel = createChatModel(model);
  const bound =
    tools.length > 0 ? chatModel.bindTools(toLangChainTools(tools) as never[]) : chatModel;

  const stream = await bound.stream(messages, {
    ...(runnableConfig.signal ? { signal: runnableConfig.signal } : {}),
  });

  // ⚠️ **用 `getWriter(config)` 而不是 `writer()`** ——
  //    1.5.3 的 `writer()` 读的是 `configurable.writer`，
  //    而框架把它挂在 `config.writer` 上（读不到就静默丢事件）
  const emit = getWriter(runnableConfig);

  let text = '';
  const toolCallChunks: Array<{ index?: number; id?: string; name?: string; args?: string }> = [];
  let usage = 0;

  for await (const chunk of stream) {
    if (runnableConfig.signal?.aborted) break;

    const piece = chunk as unknown as {
      text?: string;
      contentBlocks?: unknown;
      tool_call_chunks?: Array<{ index?: number; id?: string; name?: string; args?: string }>;
      usage_metadata?: { total_tokens?: number };
    };

    const reasoning = readReasoningDelta(piece);
    if (reasoning) {
      emit?.({ type: 'reasoning-delta', delta: reasoning });
    }

    // ⚠️ **`.text` 只取文本块** —— 思考块走上面的 reasoning，不混进正文
    const delta = piece.text;
    if (delta) {
      text += delta;
      emit?.({ type: 'text-delta', delta });
    }

    if (piece.tool_call_chunks?.length) {
      toolCallChunks.push(...piece.tool_call_chunks);
    }

    const total = piece.usage_metadata?.total_tokens;
    if (typeof total === 'number') usage = Math.max(usage, total);
  }

  const toolCalls = assembleToolCalls(toolCallChunks);
  const aiMessage = new AIMessage({
    id: nanoid(),
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });

  return {
    messages: [aiMessage],
    budgetUsed: usage,
  };
}
