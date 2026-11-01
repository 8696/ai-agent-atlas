import type { BaseMessage } from '@langchain/core/messages';
import { logger } from '../../logger.js';
import { appendEvent } from './store.js';
import type { TurnLogEventType } from './types.js';

/**
 * 会话全链路日志 —— **埋点出口**
 * （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * ⚠️ **写日志绝不能拖慢、更不能打断对话** ——
 *    这里统一「发射即忘」，失败只记错误日志（跟 `recordToolCall` 一个规矩）。
 *
 * 📌 **顺序靠 `seq` 不靠写入顺序** —— 并发写的完成顺序是乱的，
 *    但 `seq` 是同步分配的（见 `store.ts`），读的时候按它排就对了。
 */

/**
 * 这一轮的日志 id —— **优先用 `logTurnId`**（子代理的稳定 id），
 * 没有就用 `messageId`（主代理的 assistant 消息 id）。
 */
export function turnIdOf(state: {
  messageId?: string | undefined;
  logTurnId?: string | undefined;
}): string {
  return state.logTurnId || state.messageId || '';
}

/**
 * 埋点上下文 —— **「这一轮是哪个」**。
 *
 * 📌 **给「不在图节点里」的调用点用** —— 辅助模型调用
 *    （检索摘要 / 会话摘要 / 记忆抽取 / 技能沉淀）发生在服务层，
 *    它们不知道自己在哪一轮里，得由调用方把上下文传进来。
 */
export interface UtilityTrace {
  /** 这一轮的日志 id */
  turnId?: string | undefined;
  /** 会话 id */
  sessionId?: string | undefined;
}

/**
 * 记一次**辅助模型调用**（**检索摘要 / 会话摘要 / 记忆抽取 / 技能沉淀**）。
 *
 * ⚠️ **这些也是「调大模型」** —— 走便宜模型（见 `services/model-utility.ts`），
 *    不记的话日志里就少一节，「它怎么知道这件事」这条链是断的。
 */
export function logUtilityCall(
  trace: UtilityTrace,
  call: {
    /** 干什么用的（**人话**） */
    purpose: string;
    /** 用的哪个模型 */
    model: string;
    /** 发过去的输入（**全量**） */
    input: unknown;
    /** 模型返回的（**全量**） */
    output: unknown;
    /** token 用量 */
    usage?: Record<string, number> | undefined;
  },
): void {
  if (!trace.turnId || !trace.sessionId) return;
  logEvent({
    turnId: trace.turnId,
    sessionId: trace.sessionId,
    type: 'llm.utility',
    // 📌 **幂等键带用途** —— 同一轮里两种辅助调用不打架
    eventKey: `llm.utility:${call.purpose}`,
    title: `辅助模型调用 · ${call.purpose}`,
    payload: {
      purpose: call.purpose,
      model: call.model,
      input: call.input,
      output: call.output,
      usage: call.usage ?? null,
    },
  });
}

/**
 * 记一条事件（**发射即忘**）。
 *
 * @param input 事件内容
 */
export function logEvent(input: {
  turnId: string;
  sessionId: string;
  type: TurnLogEventType;
  eventKey: string;
  title: string;
  payload?: unknown;
}): void {
  if (!input.sessionId || !input.turnId) return;
  void appendEvent(input).catch((err: unknown) => {
    logger.error({ err, type: input.type }, '轮次日志写入失败');
  });
}

/**
 * 记一条事件（**等它写完**）。
 *
 * 📌 **给「收尾」这类必须落库的地方用** —— 比如一轮结束时要保证
 *    `turn.finished` 写进去了。
 */
export async function logEventAsync(input: {
  turnId: string;
  sessionId: string;
  type: TurnLogEventType;
  eventKey: string;
  title: string;
  payload?: unknown;
}): Promise<void> {
  if (!input.sessionId || !input.turnId) return;
  await appendEvent(input);
}

/**
 * 把一条消息摊成**能落库的形状**。
 *
 * ⚠️ **不能直接把 LangChain 的消息对象 JSON 化** ——
 *    它带一堆不可枚举属性与循环引用，序列化出来全是噪声。
 */
export function describeMessage(message: BaseMessage): Record<string, unknown> {
  const record = message as unknown as {
    content?: unknown;
    additional_kwargs?: Record<string, unknown>;
    tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
    tool_call_id?: string;
    name?: string;
    id?: string;
  };
  const content = record.content;
  return {
    role: message.getType(),
    id: record.id ?? null,
    name: record.name ?? null,
    content: typeof content === 'string' ? content : JSON.stringify(content ?? null),
    ...(record.tool_call_id ? { toolCallId: record.tool_call_id } : {}),
    ...(record.tool_calls && record.tool_calls.length > 0
      ? {
          toolCalls: record.tool_calls.map((call) => ({
            id: call.id ?? null,
            name: call.name ?? null,
            args: call.args ?? null,
          })),
        }
      : {}),
    ...(record.additional_kwargs && Object.keys(record.additional_kwargs).length > 0
      ? { additional: record.additional_kwargs }
      : {}),
  };
}

/** 把一批消息摊成能落库的形状 */
export function describeMessages(messages: BaseMessage[]): Array<Record<string, unknown>> {
  return messages.map(describeMessage);
}
