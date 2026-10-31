import { Sequelize } from 'sequelize-typescript';
import { paths } from './config.js';

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

export async function initDatabase(): Promise<void> {
  await sequelize.authenticate();
  // WAL：读写并发；默认 rollback journal 会让读写互相阻塞
  await sequelize.query('PRAGMA journal_mode = WAL;');
  await sequelize.query('PRAGMA foreign_keys = ON;');
  // 写锁等待，避免瞬时 SQLITE_BUSY
  await sequelize.query('PRAGMA busy_timeout = 5000;');
}
