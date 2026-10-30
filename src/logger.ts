import pino from 'pino';
import { config } from './config.js';

/**
 * 结构化日志。
 * ⚠️ 脱敏在 `lib/logger.ts`（业务侧）做 —— 密钥类字段一律打码。
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  base: { service: 'atlas' },
});
