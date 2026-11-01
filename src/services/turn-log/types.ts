/**
 * 会话全链路日志 —— **类型定义**
 * （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **一条事件 = 一步** —— 拼起来就是「这一轮到底发生了什么」：
 *    用户输入 → 上下文怎么装配 → 发给模型的完整请求 →
 *    模型返回了什么 → 工具为什么被批准/拒绝 → 工具做了什么 →
 *    记忆与技能怎么变的 → 这一轮花了多少。
 */

/** 事件类型 */
export type TurnLogEventType =
  /** 网关收到请求（**原始入参**） */
  | 'request.received'
  /** 斜杠命令（**不经过图**） */
  | 'command.executed'
  /** 上下文装配（**摘要 / 记忆 / 检索 / 技能 四段**） */
  | 'context.prepared'
  /** 发给模型的完整请求 */
  | 'llm.request'
  /** 模型的完整响应 */
  | 'llm.response'
  /** 模型降级 / 换策略 */
  | 'model.fallback'
  /**
   * ⚠️ **辅助模型调用** —— 检索摘要 / 会话摘要 / 记忆抽取 / 技能沉淀判定
   *
   * 📌 **它们也是「调大模型」** —— 走的是便宜模型（见 `services/model-utility.ts`），
   *    不记的话「它怎么知道这件事」这条链就断了一节
   */
  | 'llm.utility'
  /** 工具的权限判定 */
  | 'tool.decision'
  /** 工具要人确认 */
  | 'confirm.request'
  /** 用户对确认的答复 */
  | 'confirm.decision'
  /** 工具执行（**入参 / 出参 / 耗时 / 错误**） */
  | 'tool.execute'
  /** 记忆自动抽取 */
  | 'memory.extracted'
  /** 技能自动沉淀 */
  | 'skill.autocreated'
  /** 这一轮收尾 */
  | 'turn.finished'
  /** 这一轮出错了 */
  | 'turn.error';

/** 事件类型的中文名（**给人看的**） */
export const TURN_LOG_TYPE_LABELS: Record<TurnLogEventType, string> = {
  'request.received': '收到请求',
  'command.executed': '斜杠命令',
  'context.prepared': '上下文装配',
  'llm.request': '模型请求',
  'llm.response': '模型响应',
  'model.fallback': '模型降级',
  'llm.utility': '辅助模型调用',
  'tool.decision': '工具判定',
  'confirm.request': '等待确认',
  'confirm.decision': '确认结果',
  'tool.execute': '工具执行',
  'memory.extracted': '记忆抽取',
  'skill.autocreated': '技能沉淀',
  'turn.finished': '收尾',
  'turn.error': '出错',
};

/**
 * 轮次状态。
 *
 * 📌 **`unknown` = 有事件但没有轮次行** —— 哪条路径漏了「开一轮」，
 *    日志里不能因此看不见这些事件（见 `store.ts` 的 `readSessionLog`）。
 */
export type TurnLogStatus = 'running' | 'finished' | 'failed' | 'unknown';

/** 写一条事件的入参 */
export interface AppendEventInput {
  /** 这一轮的 id（**= assistant 消息 id**） */
  turnId: string;
  /** 会话 id */
  sessionId: string;
  /** 事件类型 */
  type: TurnLogEventType;
  /**
   * 幂等键（**同一轮内唯一**）——
   * 图节点恢复时会重跑，靠它**重写而不是重一行**。
   */
  eventKey: string;
  /** 一行摘要（**给人看的**） */
  title: string;
  /** 详情（**落库前脱敏**） */
  payload?: unknown;
}

/** 一条事件（**读出来给人看的形状**） */
export interface TurnLogEventView {
  /** 顺序号 */
  seq: number;
  /** 事件类型 */
  type: string;
  /** 类型的中文名 */
  label: string;
  /** 一行摘要 */
  title: string;
  /** 详情（**已解析的 JSON**） */
  payload: unknown;
  /** 落库时间 */
  createdAt: string;
}

/** 一轮（**读出来给人看的形状**） */
export interface TurnLogTurnView {
  /** 这一轮的 id（**= assistant 消息 id**） */
  id: string;
  /** 状态 */
  status: TurnLogStatus;
  /** 用的模型 */
  model: string | null;
  /** 开始时间 */
  startedAt: string;
  /** 结束时间 */
  endedAt: string | null;
  /** 这一轮的事件（**按顺序**） */
  events: TurnLogEventView[];
}

/** 一个会话的完整日志 */
export interface SessionTurnLog {
  sessionId: string;
  /** 轮次（**按开始时间排序**） */
  turns: TurnLogTurnView[];
}
