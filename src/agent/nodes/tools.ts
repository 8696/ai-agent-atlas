import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { getWriter } from '@langchain/langgraph';
import { config } from '../../config.js';
import { runToolCall, fingerprintOf, type ToolCard } from '../tool-node.js';
import type { AssembledToolCall } from '../tool-calls.js';
import type { AtlasStateUpdate } from '../state.js';

/**
 * `tools` 节点 —— **执行工具**（见 [12-b B4](../docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **一次只处理一个工具调用** ——
 * 节点执行一次 = 一个确认点，恢复时不会把已经执行过的工具再执行一遍
 * （见 [12-b B5](../docs/12-b-需求-对话与编排.md)「恢复不是重新跑」）。
 *
 * 📌 **工具结果回灌进图状态**（不是拼进字符串）——
 * 模型要能看到「上一次调了什么、返回了什么」。
 */

/** 图状态里跟工具执行有关的部分 */
interface ToolNodeState {
  messages: BaseMessage[];
  executedToolCalls: string[];
  lastToolName: string | null;
  lastToolCount: number;
  rejectedToolCalls: string[];
  steps: number;
  sessionId?: string | undefined;
  messageId?: string | undefined;
}

/**
 * 挑出下一个要执行的工具调用。
 *
 * ⚠️ **只看最后一条 AI 消息** —— 更早的批次已经处理完了
 * （一批调用全部执行完才会回到 `plan`）。
 */
export function pickNextToolCall(state: {
  messages: BaseMessage[];
  executedToolCalls: string[];
}): AssembledToolCall | undefined {
  const executed = new Set(state.executedToolCalls);
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message?.getType() !== 'ai') continue;
    const calls = (message as AIMessage).tool_calls ?? [];
    const next = calls.find((call) => call.id && !executed.has(call.id));
    return next as AssembledToolCall | undefined;
  }
  return undefined;
}

/** 工具节点 */
export async function toolsNode(
  state: ToolNodeState,
  runnableConfig: { signal?: AbortSignal },
): Promise<AtlasStateUpdate> {
  const call = pickNextToolCall(state);
  if (!call) return {};

  // ⚠️ **用 `getWriter(config)`** —— 见 `plan.ts` 的注释
  const emit = getWriter(runnableConfig);

  // ⚠️ **同一个工具连续调用到上限 → 停下** —— 模型陷入循环时的唯一刹车
  const consecutive =
    state.lastToolName === call.name ? (state.lastToolCount ?? 0) + 1 : 1;
  if (consecutive > config.SAME_TOOL_REPEAT_LIMIT) {
    const message =
      `同一个工具「${call.name}」已经连续调用 ${consecutive} 次，达到上限（${config.SAME_TOOL_REPEAT_LIMIT}）—— ` +
      '停下来换条路，不要再重复调用。';
    return {
      messages: [
        new ToolMessage({
          content: message,
          tool_call_id: call.id,
          status: 'error',
        }),
      ],
      executedToolCalls: [...state.executedToolCalls, call.id],
      lastToolName: call.name,
      lastToolCount: consecutive,
      haltReason: `同一个工具「${call.name}」连续调用次数已达上限`,
      notice: `已达到同工具连续调用上限（${config.SAME_TOOL_REPEAT_LIMIT} 次）`,
    };
  }

  const outcome = await runToolCall({
    call,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.messageId ? { messageId: state.messageId } : {}),
    ...(runnableConfig.signal ? { signal: runnableConfig.signal } : {}),
    rejected: new Set(state.rejectedToolCalls),
    emit: (card: ToolCard) => {
      emit?.({ type: 'tool-call', card });
    },
  });

  const rejected =
    outcome.status === 'rejected' ? [fingerprintOf(call)] : [];

  return {
    messages: [
      new ToolMessage({
        content: outcome.content,
        tool_call_id: call.id,
        status: outcome.status === 'success' ? 'success' : 'error',
      }),
    ],
    executedToolCalls: [...state.executedToolCalls, call.id],
    lastToolName: call.name,
    lastToolCount: consecutive,
    rejectedToolCalls: [...state.rejectedToolCalls, ...rejected],
    steps: (state.steps ?? 0) + 1,
  };
}
