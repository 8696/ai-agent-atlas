import { Model } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type { InferAttributes, InferCreationAttributes, ModelAttributes } from 'sequelize';

/**
 * 操作审计表（`audit_logs`）—— 见 [10 §10.9](../../docs/10-安全方案.md)。
 *
 * ⚠️ **绝不记密钥明文** —— `details` 落库前要过 `lib/security/mask.ts`。
 * ⚠️ **「用户点了批准」也要记** —— 没有账号体系，审计是唯一的「谁干的」线索。
 *
 * 📌 **不用装饰器** —— 理由见 `session.model.ts` 的注释。
 */
export class AuditLog extends Model<
  InferAttributes<AuditLog>,
  InferCreationAttributes<AuditLog>
> {
  declare id: string;

  /** 事件名（`TOOL_APPROVED` / `TOOL_BLOCKED` / `CONFIG_LOADED` …） */
  declare action: string;

  /** 目标类型（`tool` / `session` / `config` …） */
  declare target_type?: string | null;

  /** 目标 id */
  declare target_id?: string | null;

  /** JSON：细节（**已脱敏**） */
  declare details?: string | null;

  declare created_at: string;
}

/** `audit_logs` 的列定义 */
export const auditLogAttributes: ModelAttributes<
  AuditLog,
  InferCreationAttributes<AuditLog>
> = {
  id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  action: { type: DataTypes.TEXT, allowNull: false },
  target_type: { type: DataTypes.TEXT, allowNull: true },
  target_id: { type: DataTypes.TEXT, allowNull: true },
  details: { type: DataTypes.TEXT, allowNull: true },
  created_at: { type: DataTypes.TEXT, allowNull: false },
};
