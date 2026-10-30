import pino from 'pino';
import { config } from './config.js';

/**
 * 结构化日志。
 * ⚠️ 脱敏在 `lib/logger.ts`（业务侧）做 —— 密钥类字段一律打码。
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  // ⚠️ exactOptionalPropertyTypes 下不能写 `transport: cond ? {...} : undefined`，
  //    要用条件展开
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  base: { service: 'atlas' },
});
