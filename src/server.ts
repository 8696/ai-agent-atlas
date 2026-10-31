import { config } from './config.js';
import { logger } from './logger.js';
import { initDatabase } from './db.js';
import { createApp } from './app.js';

async function main() {
  await initDatabase();
  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT }, 'atlas backend listening');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
