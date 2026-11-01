import { DataType } from 'sequelize-typescript';
import type { QueryInterface } from 'sequelize';

/**
 * 004 · 会话全链路日志（`session_turn_logs` + `session_turn_log_events`）。
 *
 * 📌 **对应 [12-e E7](../docs/12-e-需求-观测安全与验收.md)** ——
 *    「一个会话一份日志」：从用户发起，到上下文装配、模型请求/响应、
 *    工具决策与执行、记忆与技能的每一步。
 *
 * ⚠️ **两张表是「轮次」与「事件」的关系** ——
 *    轮次表一行 = 一轮对话（= 一条 assistant 消息）；
 *    事件表一行 = 一个事件，按 `seq` 串起来就是这条因果链。
 *
 * ⚠️ **时间列存 UTC 墙钟字符串**（与 `001` 一致，见 [05-a §5.3](../docs/05-a-数据模型-sqlite.md)）。
 *
 * ⚠️ **迁移必须可回滚**（`down` 要写）。
 */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  // ── 轮次 ──
  await context.createTable('session_turn_logs', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    session_id: { type: DataType.TEXT, allowNull: false },
    message_id: { type: DataType.TEXT, allowNull: false },
    status: { type: DataType.TEXT, allowNull: false, defaultValue: 'running' },
    model: { type: DataType.TEXT, allowNull: true },
    started_at: { type: DataType.TEXT, allowNull: false },
    ended_at: { type: DataType.TEXT, allowNull: true },
  });
  await context.addIndex('session_turn_logs', ['session_id', 'started_at'], {
    name: 'idx_turn_logs_session',
  });

  // ── 事件 ──
  await context.createTable('session_turn_log_events', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    turn_id: { type: DataType.TEXT, allowNull: false },
    session_id: { type: DataType.TEXT, allowNull: false },
    seq: { type: DataType.INTEGER, allowNull: false },
    type: { type: DataType.TEXT, allowNull: false },
    // 📌 **幂等键** —— 图节点恢复时会重跑，同一个事件要能重写而不是重一行
    event_key: { type: DataType.TEXT, allowNull: false },
    title: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    payload: { type: DataType.TEXT, allowNull: true },
    created_at: { type: DataType.TEXT, allowNull: false },
  });
  await context.addIndex('session_turn_log_events', ['turn_id', 'seq'], {
    name: 'idx_turn_events_turn',
  });
  await context.addIndex('session_turn_log_events', ['session_id', 'seq'], {
    name: 'idx_turn_events_session',
  });
  // ⚠️ **唯一约束落在 (turn_id, event_key)** —— upsert 靠它
  await context.addIndex('session_turn_log_events', ['turn_id', 'event_key'], {
    name: 'uniq_turn_events_key',
    unique: true,
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable('session_turn_log_events');
  await context.dropTable('session_turn_logs');
}
