import { z } from 'zod';
import type { ToolDefinition } from '../../tools/types.js';

/**
 * 会话全链路日志 —— **把内部对象摊成能落库的形状**
 * （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * ⚠️ **不能直接把内部对象 JSON 化** ——
 *    zod schema、LangChain 消息、工具定义都带一堆不可枚举属性，
 *    序列化出来全是噪声（而且可能有循环引用）。
 */

/**
 * 工具清单 —— **模型这一轮到底看见了什么**。
 *
 * 📌 **带 JSON Schema** —— `zod` v4 自带 `z.toJSONSchema()`，
 *    转出来的就是发给供应商的那份入参契约。
 */
export function describeToolDefs(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    /** 敏感档（**决定要不要人确认**） */
    sensitivity: tool.sensitivity,
    /** 来源（`builtin` / `skill` / `mcp`） */
    source: tool.source,
    /** 风险说明（**确认卡片上给用户看的那句**） */
    riskNote: tool.riskNote ?? null,
    schema: toolSchema(tool),
  }));
}

/** 工具的 JSON Schema（**转不出来就空着** —— 不能因为日志挂掉） */
function toolSchema(tool: ToolDefinition): unknown {
  try {
    return z.toJSONSchema(tool.schema);
  } catch {
    return null;
  }
}

/** 一次工具调用的形状 */
export interface DescribedToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** 把模型给的工具调用摊成能落库的形状 */
export function describeToolCalls(
  calls: Array<{ id?: string | undefined; name?: string | undefined; args?: unknown }>,
): DescribedToolCall[] {
  return calls.map((call) => ({
    id: call.id ?? '',
    name: call.name ?? '',
    args: call.args ?? null,
  }));
}
