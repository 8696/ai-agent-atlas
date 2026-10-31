import { Model } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type { InferAttributes, InferCreationAttributes, ModelAttributes } from 'sequelize';

/**
 * 工具调用流水表（`tool_call_logs`）—— 见 [12-c C6](../docs/12-c-需求-工具技能与扩展.md)。
 *
 * 📌 **由工具执行包装层写入（唯一出口，不会漏记）**。
 *
 * ⚠️ **入参出参里的密钥要打码后再入库**（见 `lib/security/mask.ts`）。
 * ⚠️ **长出参入库要截断** —— 保住诊断信息，不撑爆库。
 *
 * 📌 **不用装饰器** —— 理由见 `session.model.ts` 的注释。
 */
export class ToolCallLog extends Model<
  InferAttributes<ToolCallLog>,
  InferCreationAttributes<ToolCallLog>
> {
  declare id: string;

  /** 会话 id */
  declare session_id: string;

  /** 发起这次调用的 assistant 消息 id */
  declare message_id?: string | null;

  /** 工具名 */
  declare tool_name: string;

  /** `builtin` / `skill` / `mcp` */
  declare source: string;

  /** `pending` / `running` / `success` / `error` / `rejected` / `timeout` */
  declare status: string;

  /** JSON：入参（**已打码**） */
  declare input?: string | null;

  /** JSON：出参（**已打码 + 截断**） */
  declare output?: string | null;

  /** 错误信息 */
  declare error?: string | null;

  /** 耗时（毫秒） */
  declare duration_ms: number;

  /** 0/1 —— 这次调用是否经过了人工确认 */
  declare requires_confirmation: number;

  declare created_at: string;
}

/** `tool_call_logs` 的列定义 */
export const toolCallLogAttributes: ModelAttributes<
  ToolCallLog,
  InferCreationAttributes<ToolCallLog>
> = {
  id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  session_id: { type: DataTypes.TEXT, allowNull: false },
  message_id: { type: DataTypes.TEXT, allowNull: true },
  tool_name: { type: DataTypes.TEXT, allowNull: false },
  source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'builtin' },
  status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
  input: { type: DataTypes.TEXT, allowNull: true },
  output: { type: DataTypes.TEXT, allowNull: true },
  error: { type: DataTypes.TEXT, allowNull: true },
  duration_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  requires_confirmation: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  created_at: { type: DataTypes.TEXT, allowNull: false },
};
