import pino from 'pino';
import { config } from './config.js';
import { maskString, maskValue } from './lib/security/mask.js';

/**
 * 结构化日志。
 *
 * 📌 **脱敏在这一层做** —— 密钥类字段与疑似密钥一律打码
 * （见 [12-e E4](./12-e-需求-观测安全与验收.md) 的「日志、工具流水、审计里搜不到明文密钥」）。
 *
 * ⚠️ **为什么日志也要打码** —— 供应商 SDK 会把原始报错（**常常带着请求头**）
 * 原样塞进 `err` 对象；不拦一道的话，密钥就跟着错误进日志了。
 * 📌 **流水与审计本来就有各自的打码**（`services/tool-log.ts` · `lib/audit.ts`）——
 * 日志这条是**补上的**，之前完全裸奔。
 */

/** 建日志器（**测试用得上 —— 可以把日志写到内存流里**） */
export interface LoggerOptions {
  /** 输出流（**不传就打到 stdout**） */
  destination?: pino.DestinationStream;
  /** 开发模式：走 `pino-pretty` */
  pretty?: boolean;
}

/** 打码钩子 —— 在 pino 序列化**之前**拦一道 */
const hooks = {
  // 📌 **`this` 要传给 `method`** —— pino 内部的 logMethod 靠它拿 `Symbol(pino.msgPrefix)`
  logMethod(this: unknown, args: unknown[], method: (...params: unknown[]) => void): void {
    method.apply(this, args.map((arg) => maskLogArg(arg)));
  },
};

/** 建一个日志器 */
export function createLogger(options: LoggerOptions = {}): pino.Logger {
  const { destination, pretty } = options;
  const settings: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    // ⚠️ exactOptionalPropertyTypes 下不能写 `transport: cond ? {...} : undefined`，
    //    要用条件展开
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
    base: { service: 'atlas' },
    hooks,
  };
  // 📌 **pino v10 的输出流是第二个位置参数** —— 不是 `options.stream`
  //    （`stream` 与 `transport` 也不能同时给）
  return destination ? pino(settings, destination) : pino(settings);
}

/** 默认日志器 —— 打到 stdout */
export const logger = createLogger({ pretty: config.NODE_ENV === 'development' });

/** 一个日志参数怎么打码 */
function maskLogArg(value: unknown): unknown {
  if (typeof value === 'string') return maskString(value);
  if (value === null || typeof value !== 'object') return value;
  // 📌 **Error 单独处理** —— 它的 message / stack 是不可枚举属性，
  //    走通用递归会整个抹掉（`maskValue` 里已经处理了 Error）
  return maskValue(value);
}
