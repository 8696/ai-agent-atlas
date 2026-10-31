import { nanoid } from 'nanoid';
import { ToolCallLog } from '../models/tool-call-log.model.js';
import { maskToJson } from '../lib/security/mask.js';
import { utcNow } from '../lib/time.js';

/**
 * 工具调用流水 —— **每次调用都记一笔**（见 [12-c C6](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **由工具执行包装层写入（唯一出口，不会漏记）**。
 *
 * ⚠️ **入参出参里的密钥要打码后再入库**。
 * ⚠️ **长出参入库要截断** —— 保住诊断信息，不撑爆库。
 */

/** 流水状态 */
export type ToolLogStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'rejected'
  | 'timeout';

/** 落库时截断的长度（**保住诊断信息，不撑爆库**） */
const MAX_STORED_CHARS = 8000;

/** 截断一段 JSON 文本 */
function clip(text: string): string {
  if (text.length <= MAX_STORED_CHARS) return text;
  return `${text.slice(0, MAX_STORED_CHARS)}…[已截断，共 ${text.length} 字符]`;
}

/** 写一条流水 */
export async function recordToolCall(input: {
  sessionId?: string | undefined;
  messageId?: string | undefined;
  toolName: string;
  source: string;
  status: ToolLogStatus;
  args?: unknown;
  output?: unknown;
  error?: string | undefined;
  durationMs?: number;
  requiresConfirmation?: boolean;
}): Promise<void> {
  try {
    await ToolCallLog.create({
      id: nanoid(),
      session_id: input.sessionId ?? '',
      message_id: input.messageId ?? null,
      tool_name: input.toolName,
      source: input.source,
      status: input.status,
      input: input.args === undefined ? null : clip(maskToJson(input.args)),
      output: input.output === undefined ? null : clip(maskToJson(input.output)),
      error: input.error ? clip(input.error) : null,
      duration_ms: input.durationMs ?? 0,
      requires_confirmation: input.requiresConfirmation ? 1 : 0,
      created_at: utcNow(),
    });
  } catch (err) {
    // ⚠️ **流水写失败不许打断对话** —— 用户已经看到结果了
    const { logger } = await import('../logger.js');
    logger.error({ err, tool: input.toolName }, '工具流水写入失败');
  }
}
