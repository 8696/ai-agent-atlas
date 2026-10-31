import { Model } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type { InferAttributes, InferCreationAttributes, ModelAttributes } from 'sequelize';

/**
 * 会话表（`sessions`）—— 见 [05-a §5.1](../docs/05-a-数据模型-sqlite.md)。
 *
 * ⚠️ **没有 `user_id` / `tenant_id`** —— 本地单用户、无鉴权（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **时间列存 UTC 墙钟字符串**（`YYYY-MM-DD HH:mm:ss.SSS`）——
 * 定宽 → 字典序 = 时间序，`ORDER BY last_active_at DESC` 直接可用。
 *
 * 📌 **不用装饰器**（`@Column` / `@Table`）：装饰器要靠 tsconfig 的
 * `experimentalDecorators` 才能编译，而 tsx 是**按 cwd 找 tsconfig** 的 ——
 * 从 `/tmp` 启动时它找不到项目的 tsconfig，装饰器直接编译失败
 * （见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)「从任何目录启动都指向同一份数据」）。
 * 列定义放在 `sessionAttributes`，由 `src/db.ts` 调 `Model.init` 挂上。
 */
export class Session extends Model<InferAttributes<Session>, InferCreationAttributes<Session>> {
  declare id: string;

  /** 标题 —— 首条用户消息截断生成（≤ 30 字）；可手动改 */
  declare title: string;

  /** `active` / `archived` */
  declare status: string;

  /** 0/1 —— 会话级收藏 */
  declare favorite: number;

  /** 长对话摘要（TEXT 存 JSON）—— 摘要能力落地后才有值 */
  declare summary?: string | null;

  /** JSON：`pending_confirm` 等运行时状态 */
  declare metadata?: string | null;

  /** LangGraph `thread_id`（= 会话 id，冗余存一份便于排查） */
  declare thread_id?: string | null;

  /** 冗余计数，避免列表页每次 COUNT */
  declare message_count: number;

  /** 列表排序用 */
  declare last_active_at: string;

  declare created_at: string;

  declare updated_at: string;
}

/** `sessions` 的列定义 */
export const sessionAttributes: ModelAttributes<Session, InferCreationAttributes<Session>> = {
  id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  title: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'active' },
  favorite: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  summary: { type: DataTypes.TEXT, allowNull: true },
  metadata: { type: DataTypes.TEXT, allowNull: true },
  thread_id: { type: DataTypes.TEXT, allowNull: true },
  message_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  last_active_at: { type: DataTypes.TEXT, allowNull: false },
  created_at: { type: DataTypes.TEXT, allowNull: false },
  updated_at: { type: DataTypes.TEXT, allowNull: false },
};
