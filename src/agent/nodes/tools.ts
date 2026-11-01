import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { getWriter } from '@langchain/langgraph';
import { config } from '../../config.js';
import { decideTool, disabledTools } from '../../lib/security/policy.js';
import type { InjectionScan } from '../../lib/security/injection.js';
import { mcpPolicyLookup } from '../../tools/mcp/manager.js';
import { getToolRegistry } from '../../tools/registry.js';
import { runToolCall, fingerprintOf, type ToolCard } from '../tool-node.js';
import type { AssembledToolCall } from '../tool-calls.js';
import type { AtlasStateUpdate } from '../state.js';

/**
 * `tools` 节点 —— **执行工具**（见 [12-b B4](./docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **一次只处理一个工具调用** ——
 * 节点执行一次 = 一个确认点，恢复时不会把已经执行过的工具再执行一遍
 * （见 [12-b B5](../docs/12-b-需求-对话与编排.md)「恢复不是重新跑」）。
 *
 * 📌 **例外：多个 `spawn_subagent` 可以并行** ——
 * 「同时查 A 和 B 两件事」要真的并行（见 [12-b B10](../docs/12-b-需求-对话与编排.md)）。
 * ⚠️ **只有「都不需要确认」时才并行** ——
 * 否则挂起时已经跑完的那几个会被执行第二遍。
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
  autoApprove?: string[] | undefined;
  /** 注入检测命中的特征（**空 = 没命中**） */
  injectionMatches?: string[] | undefined;
  /** ⚠️ **当前是第几层代理**（0 = 主代理）—— 传给工具，判「还能不能再派」 */
  depth?: number | undefined;
}

/**
 * 把状态里的注入特征还原成扫描结果。
 *
 * ⚠️ **权限闸要的是「这个工具要不要升档」** —— 命中就升到 `high`。
 */
function injectionOf(matches: string[] | undefined): InjectionScan {
  const list = matches ?? [];
  return { detected: list.length > 0, matches: list };
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

/**
 * 最后一条 AI 消息里**还没执行**的全部工具调用（**按顺序**）。
 */
export function pendingToolCalls(state: {
  messages: BaseMessage[];
  executedToolCalls: string[];
}): AssembledToolCall[] {
  const executed = new Set(state.executedToolCalls);
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message?.getType() !== 'ai') continue;
    const calls = ((message as AIMessage).tool_calls ?? []) as AssembledToolCall[];
    return calls.filter((call) => call.id && !executed.has(call.id));
  }
  return [];
}

/**
 * 这批调用能不能并行。
 *
 * ⚠️ **只有「全是子代理派发」且「都不需要确认」才行** ——
 * 挂起时已经跑完的那几个会被执行第二遍（确认点只能有一个）。
 *
 * 📌 **注入命中要带进来** —— 命中时档位升到 `high`，
 * 那就不能并行（并行分支不走确认闸）——
 * 见 [10 §10.7](../docs/10-安全方案.md)。
 */
export function canRunInParallel(
  calls: AssembledToolCall[],
  injection?: InjectionScan,
): boolean {
  if (calls.length < 2) return false;
  // ⚠️ **并行可以关** —— `MULTI_TOOL_CALLS=false` 时一律降级为串行
  //    （部分供应商不支持并行工具调用，见 [06 §6.2](../docs/06-大模型与模型解析.md)）
  if (!config.MULTI_TOOL_CALLS) return false;
  if (!calls.every((call) => call.name === 'spawn_subagent')) return false;

  const registry = getToolRegistry();
  const disabled = disabledTools(config);
  for (const call of calls) {
    const tool = registry.get(call.name);
    if (!tool) return false;
    const decision = decideTool(tool, {
      env: config,
      disabled,
      mcpPolicy: mcpPolicyLookup,
      args: call.args,
      // 📌 **注入命中 → 升档** —— 不传的话这条分支就是绕过升档的后门
      injection,
    });
    if (decision.decision !== 'allow') return false;
  }
  return true;
}

/** 工具节点 */
export async function toolsNode(
  state: ToolNodeState,
  runnableConfig: { signal?: AbortSignal },
): Promise<AtlasStateUpdate> {
  // ⚠️ **用 `getWriter(config)`** —— 见 `plan.ts` 的注释
  const emit = getWriter(runnableConfig);

  const pending = pendingToolCalls(state);
  if (pending.length === 0) return {};

  const call = pending[0] as AssembledToolCall;

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

  // ── 并行派发子代理（**都不需要确认时**） ──
  if (canRunInParallel(pending, injectionOf(state.injectionMatches))) {
    const outcomes = await Promise.all(
      pending.map((item) =>
        runToolCall({
          call: item,
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          ...(state.messageId ? { messageId: state.messageId } : {}),
          ...(runnableConfig.signal ? { signal: runnableConfig.signal } : {}),
          rejected: new Set(state.rejectedToolCalls),
          autoApprove: new Set(state.autoApprove ?? []),
          // 📌 **深度** —— 子代理靠它判断自己还能不能再派一层
          depth: state.depth ?? 0,
          // 📌 **注入命中 → 权限闸升档**
          injection: injectionOf(state.injectionMatches),
          emit: (card: ToolCard) => {
            emit?.({ type: 'tool-call', card });
          },
        }),
      ),
    );

    const rejected = outcomes
      .map((outcome, index) =>
        outcome.status === 'rejected' ? fingerprintOf(pending[index] as AssembledToolCall) : '',
      )
      .filter((item) => item !== '');

    return {
      messages: outcomes.map((outcome, index) =>
        new ToolMessage({
          content: outcome.content,
          tool_call_id: (pending[index] as AssembledToolCall).id,
          status: outcome.status === 'success' ? 'success' : 'error',
        }),
      ),
      executedToolCalls: [...state.executedToolCalls, ...pending.map((item) => item.id)],
      lastToolName: call.name,
      lastToolCount: consecutive,
      rejectedToolCalls: [...state.rejectedToolCalls, ...rejected],
      steps: (state.steps ?? 0) + outcomes.length,
    };
  }

  const outcome = await runToolCall({
    call,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.messageId ? { messageId: state.messageId } : {}),
    ...(runnableConfig.signal ? { signal: runnableConfig.signal } : {}),
    rejected: new Set(state.rejectedToolCalls),
    // 📌 **显式放行的工具**（无人值守场景 —— 定时任务）
    autoApprove: new Set(state.autoApprove ?? []),
    // 📌 **深度** —— 子代理靠它判断自己还能不能再派一层
    depth: state.depth ?? 0,
    // 📌 **注入命中 → 权限闸升档**（见 [10 §10.7](../../docs/10-安全方案.md)）
    injection: injectionOf(state.injectionMatches),
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
