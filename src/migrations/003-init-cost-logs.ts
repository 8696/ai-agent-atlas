import { DataType } from 'sequelize-typescript';
import type { QueryInterface } from 'sequelize';

/**
 * 003 · 成本记账表（`cost_logs`）。
 *
 * 📌 **每轮结束立刻记一条** —— token 用量取自模型返回的 `usage`
 * （见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ⚠️ **没有成本分析报表** —— 本地单用户靠 provider 侧的账单就够了；
 * 但**记账必须留**（预算闸的地基）。
 *
 * ⚠️ **`usage_scope` 区分用途** —— 对话 / 摘要 / 检索 / 记忆抽取 / 定时任务
 * 分开记，否则「摘要花了多少」永远算不出来。
 *
 * ⚠️ **时间列存 UTC 墙钟字符串**（与 `001` / `002` 一致，见 [05-a §5.3](../docs/05-a-数据模型-sqlite.md)）。
 * ⚠️ **分桶按本地时区算** —— 见 `lib/time.ts` 的 `monthStartUtcString`。
 */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.createTable('cost_logs', {
    id: { type: DataType.TEXT, allowNull: false, primaryKey: true },
    session_id: { type: DataType.TEXT, allowNull: true },
    /** 发起这次调用的 assistant 消息 id */
    message_id: { type: DataType.TEXT, allowNull: true },
    /** `anthropic` 等（**兼容端点也记成 anthropic**） */
    provider: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    /** 用的哪个模型（**换模型要能换价**） */
    model: { type: DataType.TEXT, allowNull: false, defaultValue: '' },
    /** `chat` · `memory` · `summary` · `retrieval` · `subagent` · `cron` */
    usage_scope: { type: DataType.TEXT, allowNull: false, defaultValue: 'chat' },
    prompt_tokens: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    completion_tokens: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    /** ⚠️ 推理 token **全额算输出**（Anthropic 的 thinking） */
    reasoning_tokens: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    /** 命中缓存的输入 token（**不重复计费**） */
    cached_tokens: { type: DataType.INTEGER, allowNull: false, defaultValue: 0 },
    /** 按当时价格算出来的钱（USD）—— 单价没配就是 0 */
    cost: { type: DataType.REAL, allowNull: false, defaultValue: 0 },
    created_at: { type: DataType.TEXT, allowNull: false },
  });

  await context.addIndex('cost_logs', ['created_at'], { name: 'idx_cost_logs_created' });
  await context.addIndex('cost_logs', ['session_id', 'created_at'], {
    name: 'idx_cost_logs_session',
  });
  await context.addIndex('cost_logs', ['usage_scope', 'created_at'], {
    name: 'idx_cost_logs_scope',
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable('cost_logs');
}
