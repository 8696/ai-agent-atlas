import type { ToolCallChunk } from '@langchain/core/messages';

/**
 * 流式工具调用的拼装 —— **模型在流里吐 tool_call，要自己攒起来**
 * （见 [12-b B3](../docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **一轮里既有正文又有工具调用** —— 两者在同一个流里完成，
 * 否则会出现「先回一句『我来查一下』再卡住」的两段式体验。
 */

/** 拼好的工具调用（**LangChain 的 `ToolCall` 形状**） */
export interface AssembledToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
  type: 'tool_call';
}

/**
 * 把流式 chunk 拼成完整的工具调用。
 *
 * ⚠️ **按 `index` 分组** —— 一轮里可能有多个工具调用，
 * 它们的 chunk 是交替到的。
 * ⚠️ **参数是分片的 JSON 字符串** —— 要拼完再 parse，中途 parse 会炸。
 */
export function assembleToolCalls(chunks: ToolCallChunk[]): AssembledToolCall[] {
  const groups = new Map<number, { id: string; name: string; args: string }>();

  for (const chunk of chunks) {
    const index = chunk.index ?? 0;
    const existing = groups.get(index) ?? { id: '', name: '', args: '' };
    if (chunk.id) existing.id += chunk.id;
    if (chunk.name) existing.name += chunk.name;
    if (chunk.args) existing.args += chunk.args;
    groups.set(index, existing);
  }

  const calls: AssembledToolCall[] = [];
  for (const [index, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (!group.name) continue;
    calls.push({
      name: group.name,
      args: parseArgsLoose(group.args),
      id: group.id || `call_${index}`,
      type: 'tool_call',
    });
  }
  return calls;
}

/**
 * 解析工具参数 —— **宽松一点**。
 *
 * ⚠️ **模型偶尔会吐半截 JSON** —— 解析失败就当空参数，
 * 让工具自己报「参数不对」，比整轮 500 好。
 */
export function parseArgsLoose(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}
