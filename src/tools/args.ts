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
 * 校验入参（**失败抛 `ToolArgumentError`**）。
 *
 * ⚠️ **报错文案要说清哪个字段错了** —— 模型要靠它改参数再试一次。
 */
export function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.infer<S> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
      .join('；');
    throw new ToolArgumentError(`参数不对 —— ${detail}`);
  }
  return result.data;
}
