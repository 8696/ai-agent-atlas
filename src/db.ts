import { Sequelize } from 'sequelize-typescript';
import { config } from './config.js';

/**
 * 业务库连接（SQLite）。
 * ⚠️ 向量库是**另一个文件、另一个连接**（sqlite-vec）—— 不要往这儿塞。
 */
export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: config.DATABASE_PATH,
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
