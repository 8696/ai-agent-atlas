import 'reflect-metadata';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { initDatabase } from './db.js';

const app = new Koa();

app.use(cors({ origin: config.NODE_ENV === 'production' ? false : true }));
app.use(bodyParser());
app.use(async (ctx, next) => {
  const started = Date.now();
  await next();
  logger.info(
    { method: ctx.method, path: ctx.path, status: ctx.status, ms: Date.now() - started },
    'request',
  );
});

/** 健康检查（公开路由白名单之一） */
app.use((ctx) => {
  if (ctx.path === '/api/v1/health') {
    ctx.body = { ok: true, service: 'atlas', version: '0.1.0' };
    return;
  }
  ctx.status = 404;
  ctx.body = { error: { code: 'NOT_FOUND', message: 'Not Found' } };
});

async function main() {
  await initDatabase();
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
