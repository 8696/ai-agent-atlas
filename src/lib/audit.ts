import { nanoid } from 'nanoid';
import { AuditLog } from '../models/audit-log.model.js';
import { logger } from '../logger.js';
import { maskValue } from './security/mask.js';
import { utcNow } from '../lib/time.js';

/**
 * 操作审计 —— **本地也要有**（见 [10 §10.9](../docs/10-安全方案.md)）。
 *
 * ⚠️ **绝不记密钥明文** —— `details` 落库前过 `lib/security/mask.ts`。
 * ⚠️ **「用户点了批准」也要记** —— 没有账号体系，审计是唯一的「谁干的」线索。
 */

/** 审计事件名 */
export type AuditAction =
  | 'CONFIG_LOADED'
  | 'PROMPT_UPDATED'
  | 'SKILL_INSTALLED'
  | 'SKILL_AUTOCREATED'
  | 'SKILL_AUTOUPDATED'
  | 'MCP_CONNECTED'
  | 'MEMORY_DELETED'
  | 'CRON_CREATED'
  | 'CRON_TRIGGERED'
  | 'SUBAGENT_SPAWNED'
  | 'TOOL_APPROVED'
  | 'TOOL_REJECTED'
  | 'TOOL_BLOCKED'
  | 'TOOL_EXECUTED'
  | 'TOOL_FAILED';

/** 写一条审计（**失败只记日志，不打断主流程**） */
export async function writeAudit(
  action: AuditAction,
  targetType?: string,
  targetId?: string,
  details?: unknown,
): Promise<void> {
  try {
    await AuditLog.create({
      id: nanoid(),
      action,
      target_type: targetType ?? null,
      target_id: targetId ?? null,
      details: details === undefined ? null : JSON.stringify(maskValue(details)),
      created_at: utcNow(),
    });
  } catch (err) {
    logger.error({ err, action }, '审计写入失败');
  }
}
