import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
// 📌 **只导类型** —— 编译期擦掉，不会引入运行期依赖
import type { UsageScope } from '../models/cost-log.model.js';

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
   * 步数上限（**子代理用自己的** —— 见 [12-b B10](./docs/12-b-需求-对话与编排.md)）。
   *
   * ⚠️ **不填就用全局的 `MAX_TOOL_STEPS`**。
   */
  maxSteps: Annotation<number>({
    reducer: (_current, update) => update ?? 0,
    default: () => 0,
  }),

  /**
   * ⚠️ **本轮已批准「剩下的都批准」** —— 后面的危险工具不再逐个弹确认。
   *
   * 📌 **每轮开头清零**（`prepare` 里重置）——
   *    所以它**只在这一轮有效**，下一轮还得重新问。
   *    （见 [12-b B5](./docs/12-b-需求-对话与编排.md)）
   */
  approveAllRemaining: Annotation<boolean>({
    reducer: (_current, update) => update ?? false,
    default: () => false,
  }),

  /**
   * ⚠️ **token 上限**（**子代理用自己的** —— 0 = 用全局的）。
   *
   * 📌 **子代理的花费记在主会话的月度预算里** ——
   *    没有这道闸，几个并发子代理就能把一个月的预算烧光
   *    （见 [12-d D4](./docs/12-d-需求-记忆与配置.md)）。
   */
  maxTokens: Annotation<number>({
    reducer: (_current, update) => update ?? 0,
    default: () => 0,
  }),

  /**
   * ⚠️ **本轮累计的 token**（**每轮开头清零**）。
   *
   * 📌 **与 `budgetUsed` 分开** —— `budgetUsed` 是「这个会话一共花了多少」
   *    （跨轮累加、跟着检查点持久化）；
   *    这个是「**这一轮**花了多少」，用来判单轮上限
   *    （见 [12-d D4](./docs/12-d-需求-记忆与配置.md)）。
   */
  turnTokens: Annotation<number>({
    reducer: (_current, update) => update ?? 0,
    default: () => 0,
  }),

  /**
   * ⚠️ **当前是第几层代理**（0 = 主代理 · 1 = 子代理 · 2 = 孙代理）。
   *
   * 📌 **深度上限是 `SUBAGENT_MAX_DEPTH`** ——
   *    到了上限就**不再给这一层 `spawn_subagent` 工具**（模型看不见它），
   *    防递归（见 [12-b B10](./docs/12-b-需求-对话与编排.md)）。
   */
  depth: Annotation<number>({
    reducer: (_current, update) => update ?? 0,
    default: () => 0,
  }),

  /**
   * 隔离模式（**子代理专用**）。
   *
   * ⚠️ **为 true 时不加载主对话的历史与摘要** ——
   *    子代理只拿得到「任务」这一条（见 [12-b B10](./docs/12-b-需求-对话与编排.md)）。
   */
  isolated: Annotation<boolean>({
    reducer: (_current, update) => update ?? false,
    default: () => false,
  }),

  /**
   * 这一轮的用量归到哪个桶（**`cost_logs.usage_scope`**）。
   *
   * ⚠️ **默认 `chat`** —— 定时任务会传 `cron`，
   *    这样「定时任务花了多少」在 `yarn cost:report` 里单独看得见
   *    （见 [12-b B11](./12-b-需求-对话与编排.md)）。
   */
  usageScope: Annotation<UsageScope>({
    reducer: (_current, update) => update ?? 'chat',
    default: () => 'chat',
  }),

  /**
   * 模型覆盖（**子代理可指定** —— 默认继承主模型）。
   *
   * ⚠️ **只认主模型与备用模型** —— 认不出来就用主模型。
   */
  model: Annotation<string>({
    reducer: (_current, update) => update ?? '',
    default: () => '',
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

  /**
   * 注入检测命中的特征（**空数组 = 没命中**）。
   *
   * ⚠️ **必须带到权限闸里** —— 只收紧「给模型看的那份副本」是空的
   *    （闸读的是注册表里的原定义，见 [10 §10.7](../docs/10-安全方案.md)）。
   *
   * 📌 **只放特征名** —— 状态要能落盘（checkpointer 序列化进 SQLite）。
   */
  injectionMatches: Annotation<string[]>({
    reducer: (_current, update) => update ?? [],
    default: () => [],
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
   * 允许自动放行的工具名（**无人值守场景专用** —— 定时任务）。
   *
   * ⚠️ **高危** —— 列在这里的工具跳过人工确认闸。
   * 只有用户在定时任务里显式写出来才生效（见 [12-b B11](./docs/12-b-需求-对话与编排.md)）。
   */
  autoApprove: Annotation<string[]>({
    reducer: (_current, update) => update ?? [],
    default: () => [],
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
