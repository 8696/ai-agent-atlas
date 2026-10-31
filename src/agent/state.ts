import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

/**
 * 图状态 —— **集中在 `agent/state.ts`**（见 [03-b §B.5.2](../docs/03-b-技术栈-后端栈.md)）。
 *
 * 📌 **带 reducer 的字段（`messages`）用 `messagesStateReducer`**。
 *
 * ⚠️ **状态要能落盘** —— checkpointer 把它序列化进 SQLite，
 * 所以字段里只放**可序列化的东西**（消息、字符串、数字、数组）。
 */

/** 待确认的工具调用（**挂起时的载荷**） */
export interface PendingConfirm {
  /** 工具调用 id（**批准只对这一次调用有效**） */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 入参（**给用户看的**） */
  args: unknown;
  /** 风险说明（**给用户看的**） */
  risk: string;
  /** 入参指纹 —— ⚠️ **参数变了就不能沿用旧的批准** */
  fingerprint: string;
}

/** 图状态 */
export const AtlasState = Annotation.Root({
  /**
   * 本轮对话消息（**用户历史 + 本轮消息 + 工具消息**）。
   *
   * ⚠️ **每轮开头由 `prepare` 节点重置** —— 前端的历史才是真相
   * （「重新生成」要把上一条回答砍掉，状态里也得跟着砍）。
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /**
   * 本轮输入（**网关传进来的前端历史**）。
   *
   * 📌 **单独一个通道** —— 因为 `messages` 是「追加」语义，
   * 而本轮输入是「整体替换」。
   */
  turnMessages: Annotation<BaseMessage[]>({
    reducer: (_current, update) => update ?? [],
    default: () => [],
  }),

  /**
   * 会话摘要（**早期对话折出来的那一段**）。
   *
   * 📌 **由 `prepare` 节点算好** —— 摘要边界之前不再喂原文，
   * 只把这一段放进系统提示词（见 [12-d D1](../docs/12-d-需求-记忆与配置.md)）。
   */
  summary: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
  }),

  /**
   * 召回的长期记忆（**注入系统提示词**）。
   *
   * 📌 **由 `prepare` 节点算好** —— 每轮只算一次，
   * 不在 `plan` 里反复算（见 [12-d D2](../docs/12-d-需求-记忆与配置.md)）。
   */
  memories: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
  }),

  /**
   * 跨会话检索的摘要（**注入系统提示词，排在记忆后面**）。
   *
   * 📌 **由 `prepare` 节点算好** —— 检索要调一次模型，
   * 放节点里算就不会在工具循环里重复调（见 [12-d D3](../docs/12-d-需求-记忆与配置.md)）。
   */
  retrieval: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
  }),

  /**
   * 命中的技能说明（**注入系统提示词**）。
   *
   * 📌 **由 `prepare` 节点算好** —— 技能匹配走 FTS5，
   * 放节点里算就不会在工具循环里重复查（见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
   */
  skills: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
  }),

  /** 已执行的工具调用 id（**同一轮内不重复执行**） */
  executedToolCalls: Annotation<string[]>({
    reducer: (_current, update) => update ?? [],
    default: () => [],
  }),

  /**
   * 上一个执行的工具名（**用来算「连续」调用次数**）。
   *
   * ⚠️ **模型陷入死循环时的唯一刹车**（见 [12-b B4](../docs/12-b-需求-对话与编排.md)）。
   */
  lastToolName: Annotation<string | null>({
    reducer: (_current, update) => update ?? null,
    default: () => null,
  }),

  /** 上一个工具连续被调用了几次 */
  lastToolCount: Annotation<number>({
    reducer: (_current, update) => update ?? 0,
    default: () => 0,
  }),

  /**
   * 已被用户拒绝的工具调用（**指纹集合**）。
   *
   * ⚠️ **模型不得再问第三次** —— 拒绝过的调用再出现时直接回灌「已拒绝」，不再弹确认。
   */
  rejectedToolCalls: Annotation<string[]>({
    reducer: (_current, update) => update ?? [],
    default: () => [],
  }),

  /** 本轮已走的步数（**超过上限直接进 answer**） */
  steps: Annotation<number>({
    reducer: (_current, update) => update ?? 0,
    default: () => 0,
  }),

  /**
   * 已用预算（**累计，不因重启归零**）。
   *
   * ⚠️ **跨轮累计** —— 预算闸看的是「这个会话一共花了多少」。
   */
  budgetUsed: Annotation<number>({
    reducer: (current, update) => (current ?? 0) + (update ?? 0),
    default: () => 0,
  }),

  /** 给用户看的一行提示（**比如「已达到步数上限」**） */
  notice: Annotation<string | null>({
    reducer: (_current, update) => update ?? null,
    default: () => null,
  }),

  /**
   * 停下来的原因（**非空 = 直接进回答节点，不再调模型**）。
   *
   * ⚠️ **步数上限 / 同工具重复上限** —— 命中就停，别把预算烧穿。
   */
  haltReason: Annotation<string | null>({
    reducer: (_current, update) => update ?? null,
    default: () => null,
  }),

  /**
   * 本轮最终的正文（**回答节点写**）。
   *
   * ⚠️ **不能叫 `answer`** —— 那是图节点的名字，
   * 状态通道与节点同名会直接编译失败。
   */
  finalText: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
  }),

  /** 会话 id（**写工具流水用**） */
  sessionId: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
  }),

  /**
   * 这一轮的 assistant 消息 id（**服务端生成，落库与前端对得上**）。
   *
   * ⚠️ **恢复时不能变** —— 挂在检查点里，重启后还是同一个 id，
   * 续跑时更新的是同一条消息，不会多出一条。
   */
  messageId: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
  }),
});

/** 图状态的值类型 */
export type AtlasStateValue = typeof AtlasState.State;

/** 图状态的更新类型 */
export type AtlasStateUpdate = typeof AtlasState.Update;
