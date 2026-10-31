import { Model } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type { InferAttributes, InferCreationAttributes, ModelAttributes } from 'sequelize';

/**
 * 成本记账表（`cost_logs`）—— 见 [12-d D4](../docs/12-d-需求-记忆与配置.md)
 * 与 [05-a §5.1](../docs/05-a-数据模型-sqlite.md)。
 *
 * ⚠️ **每轮结束记一条** —— 没有它就做不了预算闸。
 *
 * 📌 **不用装饰器** —— 理由见 `session.model.ts` 的注释。
 */

/** 花费的用途（**分开记** —— 否则「摘要花了多少」算不出来） */
export type UsageScope =
  | 'chat'
  | 'memory'
  | 'summary'
  | 'retrieval'
  | 'subagent'
  | 'cron'
  | 'skill';

export class CostLog extends Model<InferAttributes<CostLog>, InferCreationAttributes<CostLog>> {
  declare id: string;

  /** 所属会话（**摘要 / 检索可能没有会话**） */
  declare session_id?: string | null;

  /** 发起这次调用的 assistant 消息 id */
  declare message_id?: string | null;

  /** 供应商（**兼容端点也记成 anthropic**） */
  declare provider: string;

  /** 用的哪个模型 */
  declare model: string;

  /** 用途 */
  declare usage_scope: UsageScope;

  /** 输入 token */
  declare prompt_tokens: number;

  /** 输出 token（**含推理 token**） */
  declare completion_tokens: number;

  /** 推理 token（**全额算输出**） */
  declare reasoning_tokens: number;

  /** 命中缓存的输入 token */
  declare cached_tokens: number;

  /** 费用（USD）—— 单价没配就是 0 */
  declare cost: number;

  declare created_at: string;
}

/** `cost_logs` 的列定义 */
export const costLogAttributes: ModelAttributes<CostLog, InferCreationAttributes<CostLog>> = {
  id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  session_id: { type: DataTypes.TEXT, allowNull: true },
  message_id: { type: DataTypes.TEXT, allowNull: true },
  provider: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  model: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  usage_scope: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'chat' },
  prompt_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  completion_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  reasoning_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  cached_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  cost: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
  created_at: { type: DataTypes.TEXT, allowNull: false },
};
