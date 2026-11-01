import { z } from 'zod';

/**
 * 工具入参校验 —— **所有工具共用**（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **入参出错不是异常，是「回灌给模型的错误文本」** ——
 * 工具异常不能中断整轮（见 [12-b B4](../docs/12-b-需求-对话与编排.md)）。
 */

/** 入参不合法（**转成错误文本回灌**） */
export class ToolArgumentError extends Error {
  readonly code: string;

  constructor(message: string, code = 'INVALID_TOOL_ARGS') {
    super(message);
    this.name = 'ToolArgumentError';
    this.code = code;
  }
}

/** 字符串入参上限（**默认 1 万字符**） */
export const MAX_STRING = 10_000;
/** 数组入参上限（**默认 100 项**） */
export const MAX_ARRAY = 100;

/**
 * 整份入参的体积上限（**序列化后的字符数**）。
 *
 * ⚠️ **单个字段有上限还不够** —— 第三方 MCP server 的 schema
 *    可能有 `z.unknown()` 字段（结构不认识就放宽），
 *    模型往里塞一整本书也照样过。
 *    这道闸对**所有工具**生效（见 `assertArgsSize`）。
 */
export const MAX_ARGS_CHARS = 200_000;

/** 入参嵌套层数上限（**防深递归把进程绕死**） */
const MAX_ARGS_DEPTH = 12;

/** 常用 schema 片段 */
export const schemas = {
  /** 一段文本（**有长度上限**） */
  text: (max = MAX_STRING) => z.string().max(max),
  /** 一个路径（**非空、不含空字节**） */
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes('\0'), { message: '路径不能含空字节' }),
  /** 一个小列表 */
  list: <T extends z.ZodType>(item: T) => z.array(item).max(MAX_ARRAY),
};

/**
 * 入参体积与深度的闸（**所有工具都要过**）。
 *
 * ⚠️ **MCP 工具也要过** —— 它们的 schema 是第三方写的，
 *    字段可能是「不认识就放宽」的类型，没有这道闸就能往上下文里塞超大字符串。
 *
 * @throws ToolArgumentError 参数太大 / 太深 / 序列化不了
 */
export function assertArgsSize(args: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(args ?? null) ?? '';
  } catch {
    throw new ToolArgumentError('参数序列化失败（可能有循环引用或不可序列化的值）');
  }
  if (text.length > MAX_ARGS_CHARS) {
    throw new ToolArgumentError(
      `参数太大了（${text.length} 字符 > 上限 ${MAX_ARGS_CHARS}）—— 拆成几次调用`,
    );
  }
  if (depthOf(args, 0) > MAX_ARGS_DEPTH) {
    throw new ToolArgumentError(`参数嵌套太深（超过 ${MAX_ARGS_DEPTH} 层）`);
  }
}

/** 数一个值的嵌套层数 */
function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_ARGS_DEPTH + 1) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, depthOf(item, depth + 1));
    return max;
  }
  if (value && typeof value === 'object') {
    let max = depth;
    for (const item of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, depthOf(item, depth + 1));
    }
    return max;
  }
  return depth;
}

/**
 * 校验入参（**失败抛 `ToolArgumentError`**）。
 *
 * ⚠️ **报错文案要说清哪个字段错了** —— 模型要靠它改参数再试一次。
 */
export function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.infer<S> {
  // 📌 **先过体积闸** —— schema 认不出来的字段也拦得住
  assertArgsSize(args);
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
      .join('；');
    throw new ToolArgumentError(`参数不对 —— ${detail}`);
  }
  return result.data;
}
