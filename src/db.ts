import { Sequelize } from 'sequelize-typescript';
import { paths } from './config.js';
import { AuditLog, auditLogAttributes } from './models/audit-log.model.js';
import { CostLog, costLogAttributes } from './models/cost-log.model.js';
import { Message, messageAttributes } from './models/message.model.js';
import { Session, sessionAttributes } from './models/session.model.js';
import { ToolCallLog, toolCallLogAttributes } from './models/tool-call-log.model.js';

/**
 * 业务库连接（SQLite）。
 *
 * ⚠️ **用绝对路径**（`paths.databaseFile`）——
 * 相对路径会被相对 `process.cwd()` 解析，
 * 从别的目录启动就会**在错误的位置建一个新库**（最隐蔽的一类 bug）。
 */
export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: paths.databaseFile,
  logging: false,
  pool: { max: 1, min: 0, idle: 10_000 },
});

/**
 * ⚠️ **模型必须挂上** —— 忘了挂的话第一次 `.findAll()` 才崩（见 AGENTS.md §4.2）。
 *
 * 📌 **在这里显式 `initialize`，不用装饰器**：
 * 装饰器要靠 tsconfig 的 `experimentalDecorators` 才能编译，
 * 而 tsx 是**按 cwd 找 tsconfig** 的 —— 从 `/tmp` 启动就找不到，
 * 装饰器会直接编译失败（见 [12-a A1](./docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **用 `initialize` 不是 `init`** —— sequelize-typescript 的 `init` 代理会
 * 在模型标记为已初始化之前就去问表名，直接抛「Model not initialized」。
 */
Session.initialize(sessionAttributes, {
  sequelize,
  tableName: 'sessions',
  timestamps: false,
});
Message.initialize(messageAttributes, {
  sequelize,
  tableName: 'messages',
  timestamps: false,
});
ToolCallLog.initialize(toolCallLogAttributes, {
  sequelize,
  tableName: 'tool_call_logs',
  timestamps: false,
});
AuditLog.initialize(auditLogAttributes, {
  sequelize,
  tableName: 'audit_logs',
  timestamps: false,
});
CostLog.initialize(costLogAttributes, {
  sequelize,
  tableName: 'cost_logs',
  timestamps: false,
});

export async function initDatabase(): Promise<void> {
  await sequelize.authenticate();
  // WAL：读写并发；默认 rollback journal 会让读写互相阻塞
  await sequelize.query('PRAGMA journal_mode = WAL;');
  await sequelize.query('PRAGMA foreign_keys = ON;');
  // 写锁等待，避免瞬时 SQLITE_BUSY
  await sequelize.query('PRAGMA busy_timeout = 5000;');
}
