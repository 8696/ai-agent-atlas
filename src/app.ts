import 'reflect-metadata';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { AppError, registerSecret } from './lib/errors.js';
import { chatRouter } from './gateway/chat-routes.js';

/**
 * Koa 应用装配 —— **与「启动」分开**。
 *
 * 📌 **拆开是为了能测**：集成测试用 `createApp().callback()` 起一个临时端口，
 * 不用真的 `listen`（见 `tests/integration/chat-sse.test.ts`）。
 * ⚠️ **测路由不许打真模型** —— 模型一律 mock，否则一次用例几十秒。
 */
export function createApp(): Koa {
  const app = new Koa();

  // ⚠️ **密钥注册进打码表** —— 出错时也不许把 Key 泄进响应或日志
  registerSecret(config.LLM_API_KEY);
  registerSecret(config.LLM_FALLBACK_API_KEY);

  // 生产是同源部署 → 不挂 CORS 中间件；开发放开给 Vite
  if (config.NODE_ENV !== 'production') {
    app.use(cors({ origin: '*' }));
  }
  app.use(bodyParser());
  app.use(async (ctx, next) => {
    const started = Date.now();
    await next();
    logger.info(
      { method: ctx.method, path: ctx.path, status: ctx.status, ms: Date.now() - started },
      'request',
    );
  });

  /**
   * 统一错误体 —— `{ "error": { "code": "...", "message": "..." } }`（见 [03-b §B.10](./docs/03-b-技术栈-后端栈.md)）。
   *
   * ⚠️ **内部错误不回显堆栈** —— 只给一句人话，细节进日志。
   */
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof AppError) {
        ctx.status = err.status;
        ctx.body = err.toBody();
        return;
      }
      logger.error({ err, path: ctx.path }, 'unhandled error');
      ctx.status = 500;
      ctx.body = {
        error: { code: 'INTERNAL_ERROR', message: '服务内部错误，看后端日志' },
      };
    }
  });

  /** 对话与模型（`/api/v1/chat` · `/api/v1/models`） */
  app.use(chatRouter.routes());
  app.use(chatRouter.allowedMethods());

  /** 健康检查（公开路由白名单之一） */
  app.use((ctx) => {
    if (ctx.path === '/api/v1/health') {
      ctx.body = { ok: true, service: 'atlas', version: '0.1.0' };
      return;
    }
    ctx.status = 404;
    ctx.body = { error: { code: 'NOT_FOUND', message: 'Not Found' } };
  });

  return app;
}
