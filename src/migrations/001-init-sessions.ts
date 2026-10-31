import { DataType } from 'sequelize-typescript';
import type { QueryInterface } from 'sequelize';

/**
 * 001 · 建会话表与消息表。
 *
 * ⚠️ **时间列存 UTC 墙钟字符串**（`YYYY-MM-DD HH:mm:ss.SSS`）——
 * 定宽 → 字典序 = 时间序，排序与索引都直接可用（见 [05-a §5.3](../docs/05-a-数据模型-sqlite.md)）。
 *
 * ⚠️ **迁移必须可回滚**（`down` 要写）—— 见 [05-a §5.5](../docs/05-a-数据模型-sqlite.md)。
 *
 * 📌 **`graph_checkpoints` 不在这里建** —— 那是 LangGraph 的 checkpointer 自己管的表
 * （见 [12-b B6](../docs/12-b-需求-对话与编排.md)）；
 * **`tool_call_logs` 也不在这里建** —— 属于工具流水那条需求（[12-c C6](../docs/12-c-需求-工具技能与扩展.md)）。
 * 但**删会话的级联清理已经把它们算进去了**：表存在就清、不存在就跳过。
 */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.createTable('sessions', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    title: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    status: { type: DataType.TEXT, allowNull: false, defaultValue: 'active' },
    favorite: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    summary: { type: DataType.TEXT, allowNull: true },
    metadata: { type: DataType.TEXT, allowNull: true },
    thread_id: { type: DataType.TEXT, allowNull: true },
    message_count: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    last_active_at: { type: DataType.TEXT, allowNull: false },
    created_at: { type: DataType.TEXT, allowNull: false },
    updated_at: { type: DataType.TEXT, allowNull: false },
  });

  await context.addIndex('sessions', ['last_active_at'], { name: 'idx_sessions_last' });
  await context.addIndex('sessions', ['favorite'], { name: 'idx_sessions_favorite' });

  await context.createTable('messages', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    session_id: { type: DataType.TEXT, allowNull: false },
    role: { type: DataType.TEXT, allowNull: false },
    content: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    parts: { type: DataType.TEXT, allowNull: true },
    tool_calls: { type: DataType.TEXT, allowNull: true },
    tool_results: { type: DataType.TEXT, allowNull: true },
    attachments: { type: DataType.TEXT, allowNull: true },
    favorite: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    metadata: { type: DataType.TEXT, allowNull: true },
    created_at: { type: DataType.TEXT, allowNull: false },
    updated_at: { type: DataType.TEXT, allowNull: false },
  });

  await context.addIndex('messages', ['session_id', 'created_at'], {
    name: 'idx_messages_session',
  });
  await context.addIndex('messages', ['favorite'], { name: 'idx_messages_favorite' });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable('messages');
  await context.dropTable('sessions');
}
