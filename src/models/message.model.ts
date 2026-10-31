import { Model } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type { InferAttributes, InferCreationAttributes, ModelAttributes } from 'sequelize';

/**
 * 消息表（`messages`）—— 见 [05-a §5.1](../docs/05-a-数据模型-sqlite.md)。
 *
 * ⚠️ **`parts` 是「刷新后卡片还在」的依据**：
 * 前端渲染工具卡片读的是落库的 `parts`，不是重新拉一次执行记录。
 * 改 part 结构要同时改前端渲染分支。
 *
 * 📌 **不用装饰器** —— 理由见 `session.model.ts` 的注释（从别的目录启动会编译失败）。
 */
export class Message extends Model<InferAttributes<Message>, InferCreationAttributes<Message>> {
  declare id: string;

  /** 外键 → `sessions.id` */
  declare session_id: string;

  /** `user` / `assistant` / `system` / `tool` */
  declare role: string;

  /** 纯文本正文（Markdown 源） */
  declare content: string;

  /** JSON 数组：结构化 part（含工具调用卡片、待确认卡片） */
  declare parts?: string | null;

  /** JSON：assistant 消息发起的工具调用 */
  declare tool_calls?: string | null;

  /** JSON：工具执行结果 */
  declare tool_results?: string | null;

  /** JSON：附件引用 */
  declare attachments?: string | null;

  /** 0/1 —— 消息级收藏 */
  declare favorite: number;

  /** JSON：`model` / `usage` / `stop_reason` 等 */
  declare metadata?: string | null;

  declare created_at: string;

  declare updated_at: string;
}

/** `messages` 的列定义 */
export const messageAttributes: ModelAttributes<Message, InferCreationAttributes<Message>> = {
  id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  session_id: { type: DataTypes.TEXT, allowNull: false },
  role: { type: DataTypes.TEXT, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  parts: { type: DataTypes.TEXT, allowNull: true },
  tool_calls: { type: DataTypes.TEXT, allowNull: true },
  tool_results: { type: DataTypes.TEXT, allowNull: true },
  attachments: { type: DataTypes.TEXT, allowNull: true },
  favorite: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  metadata: { type: DataTypes.TEXT, allowNull: true },
  created_at: { type: DataTypes.TEXT, allowNull: false },
  updated_at: { type: DataTypes.TEXT, allowNull: false },
};
