import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Umzug, SequelizeStorage } from 'umzug';
import { sequelize, initDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const umzug = new Umzug({
  migrations: {
    glob: ['migrations/*.ts', { cwd: path.resolve(here, '../src') }],
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: console,
});

async function main() {
  await initDatabase();
  const undo = process.argv.includes('--undo');
  const pending = await umzug.pending();
  if (pending.length === 0) {
    logger.info('没有待执行的迁移');
    return;
  }
  if (undo) {
    await umzug.down();
    logger.info('已回滚最后一个迁移');
    return;
  }
  await umzug.up();
  logger.info({ count: pending.length }, '迁移完成');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '迁移失败');
    process.exit(1);
  });
}
