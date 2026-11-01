import { Model } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type { InferAttributes, InferCreationAttributes, ModelAttributes } from 'sequelize';

/**
 * 会话轮次日志（`session_turn_logs`）—— **一轮对话一行**
 * （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **一轮 = 一条 assistant 消息** —— 工具循环、中断恢复都算同一轮，
 *    所以主键直接用 `messageId`（**图状态、工具流水、落库用的是同一个 id**）。
 *
 * ⚠️ **跟会话的关系** —— `session_id` 是外键指向 `sessions.id`，
 *    删会话时**级联删掉**这些日志（见 `services/session.ts` 的 `deleteSession`）。
 *
 * 📌 **不用装饰器** —— 理由见 `session.model.ts` 的注释。
 */
export class TurnLog extends Model<InferAttributes<TurnLog>, InferCreationAttributes<TurnLog>> {
  declare id: string;

  /** 外键 → `sessions.id` */
  declare session_id: string;

  /** 这一轮的 assistant 消息 id（**= 主键**） */
  declare message_id: string;

  /** `running` / `finished` / `failed` */
  declare status: string;

  /** 这一轮用的模型 */
  declare model?: string | null;

  declare started_at: string;

  declare ended_at?: string | null;
}

/** `session_turn_logs` 的列定义 */
export const turnLogAttributes: ModelAttributes<TurnLog, InferCreationAttributes<TurnLog>> = {
  id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  session_id: { type: DataTypes.TEXT, allowNull: false },
  message_id: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'running' },
  model: { type: DataTypes.TEXT, allowNull: true },
  started_at: { type: DataTypes.TEXT, allowNull: false },
  ended_at: { type: DataTypes.TEXT, allowNull: true },
};

/**
 * 轮次日志事件（`session_turn_log_events`）—— **一个事件一行**
 * （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **按事件流存，不是一轮一大坨** ——
 *    「用户输入 → 上下文装配 → 模型请求 → 模型响应 → 工具决策 → 工具执行 → 收尾」
 *    是一条**因果链**，拆成事件才能按顺序读，也才能增量追加。
 *
 * ⚠️ **`event_key` 保证幂等** —— 图节点在恢复时会重跑一遍
 *    （见 [12-b B5](../docs/12-b-需求-对话与编排.md)），
 *    同一个事件重写而不是重一行。
 *
 * ⚠️ **payload 里的密钥要打码后再入库**（见 `lib/security/mask.ts`）。
 */
export class TurnLogEvent extends Model<
  InferAttributes<TurnLogEvent>,
  InferCreationAttributes<TurnLogEvent>
> {
  declare id: string;

  /** 外键 → `session_turn_logs.id` */
  declare turn_id: string;

  /** 冗余一份会话 id —— 查一个会话的日志时不用 join */
  declare session_id: string;

  /** 顺序号（**全局单调递增** —— 排序靠它，不靠写入顺序） */
  declare seq: number;

  /** 事件类型（`llm.request` / `tool.execute` …） */
  declare type: string;

  /** 幂等键（**与 `turn_id` 组成唯一索引**） */
  declare event_key: string;

  /** 一行摘要（**给人看的**） */
  declare title: string;

  /** JSON：事件详情（**已脱敏**） */
  declare payload?: string | null;

  declare created_at: string;
}

/** `session_turn_log_events` 的列定义 */
export const turnLogEventAttributes: ModelAttributes<
  TurnLogEvent,
  InferCreationAttributes<TurnLogEvent>
> = {
  id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  turn_id: { type: DataTypes.TEXT, allowNull: false },
  session_id: { type: DataTypes.TEXT, allowNull: false },
  seq: { type: DataTypes.INTEGER, allowNull: false },
  type: { type: DataTypes.TEXT, allowNull: false },
  event_key: { type: DataTypes.TEXT, allowNull: false },
  title: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  payload: { type: DataTypes.TEXT, allowNull: true },
  created_at: { type: DataTypes.TEXT, allowNull: false },
};
