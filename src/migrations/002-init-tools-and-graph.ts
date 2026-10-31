import { DataType } from 'sequelize-typescript';
import type { QueryInterface } from 'sequelize';

/**
 * 002 · 工具流水、审计日志与图检查点。
 *
 * 📌 **三张表对应三条需求**：
 * - `tool_call_logs` —— 工具调用流水（[12-c C6](../docs/12-c-需求-工具技能与扩展.md)）
 * - `audit_logs` —— 操作审计（[12-e E4](../docs/12-e-需求-观测安全与验收.md)）
 * - `graph_checkpoints` / `graph_checkpoint_writes` —— LangGraph 检查点
 *   （[12-b B6](../docs/12-b-需求-对话与编排.md)）
 *
 * ⚠️ **检查点表由本项目自己的 saver 管**（`src/agent/checkpointer.ts`）——
 * 不是 LangGraph 官方 SQLite saver 建的，所以这里要手写迁移。
 *
 * ⚠️ **时间列存 UTC 墙钟字符串**（与 `001` 一致，见 [05-a §5.3](../docs/05-a-数据模型-sqlite.md)）。
 *
 * ⚠️ **迁移必须可回滚**（`down` 要写）。
 */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  // ── 工具调用流水 ──
  await context.createTable('tool_call_logs', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    session_id: { type: DataType.TEXT, allowNull: false },
    message_id: { type: DataType.TEXT, allowNull: true },
    tool_name: { type: DataType.TEXT, allowNull: false },
    source: { type: DataType.TEXT, allowNull: false, defaultValue: 'builtin' },
    status: { type: DataType.TEXT, allowNull: false, defaultValue: 'pending' },
    input: { type: DataType.TEXT, allowNull: true },
    output: { type: DataType.TEXT, allowNull: true },
    error: { type: DataType.TEXT, allowNull: true },
    duration_ms: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    requires_confirmation: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataType.TEXT, allowNull: false },
  });
  await context.addIndex('tool_call_logs', ['session_id', 'created_at'], {
    name: 'idx_tool_logs_session',
  });
  await context.addIndex('tool_call_logs', ['tool_name', 'created_at'], {
    name: 'idx_tool_logs_tool',
  });

  // ── 操作审计 ──
  await context.createTable('audit_logs', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    action: { type: DataType.TEXT, allowNull: false },
    target_type: { type: DataType.TEXT, allowNull: true },
    target_id: { type: DataType.TEXT, allowNull: true },
    details: { type: DataType.TEXT, allowNull: true },
    created_at: { type: DataType.TEXT, allowNull: false },
  });
  await context.addIndex('audit_logs', ['created_at'], { name: 'idx_audit_logs_created' });

  // ── 图检查点 ──
  // ⚠️ **`data` 存 base64 的 TEXT** —— LangGraph 的状态用 JsonPlus 序列化，
  //    里面可能有二进制（附件），直接存 TEXT 会被截断；
  //    base64 是「二进制安全 + 不依赖驱动 BLOB 绑定」的两全
  await context.createTable('graph_checkpoints', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    thread_id: { type: DataType.TEXT, allowNull: false },
    checkpoint_ns: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    checkpoint_id: { type: DataType.TEXT, allowNull: false },
    parent_checkpoint_id: { type: DataType.TEXT, allowNull: true },
    /** `checkpoint` / `metadata` —— **同一个检查点存两行** */
    type: { type: DataType.TEXT, allowNull: false, defaultValue: 'checkpoint' },
    /** 序列化器自己的类型（`json` / `bytes`） */
    serde_type: { type: DataType.TEXT, allowNull: false, defaultValue: 'json' },
    data: { type: DataType.TEXT, allowNull: true },
    created_at: { type: DataType.TEXT, allowNull: false },
  });
  await context.addIndex('graph_checkpoints', ['thread_id', 'checkpoint_id'], {
    name: 'idx_gc_thread',
  });

  // ⚠️ **待写入（pending writes）单独一张表** —— 检查点表是「一个检查点一行」，
  //    而待写入是「一个任务一行」，粒度不同
  await context.createTable('graph_checkpoint_writes', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    thread_id: { type: DataType.TEXT, allowNull: false },
    checkpoint_ns: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    checkpoint_id: { type: DataType.TEXT, allowNull: false },
    task_id: { type: DataType.TEXT, allowNull: false },
    task_path: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    idx: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    channel: { type: DataType.TEXT, allowNull: false },
    /** 序列化器自己的类型（`json` / `bytes`） */
    serde_type: { type: DataType.TEXT, allowNull: false, defaultValue: 'json' },
    data: { type: DataType.TEXT, allowNull: true },
    created_at: { type: DataType.TEXT, allowNull: false },
  });
  await context.addIndex(
    'graph_checkpoint_writes',
    ['thread_id', 'checkpoint_ns', 'checkpoint_id'],
    { name: 'idx_gcw_checkpoint' },
  );
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable('graph_checkpoint_writes');
  await context.dropTable('graph_checkpoints');
  await context.dropTable('audit_logs');
  await context.dropTable('tool_call_logs');
}
