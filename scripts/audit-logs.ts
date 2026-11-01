import { Op } from 'sequelize';
import { initDatabase } from '../src/db.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { logger } from '../src/logger.js';

/**
 * 审计日志查询 —— `yarn audit:logs`
 * （见 [12-e E4](./docs/12-e-需求-观测安全与验收.md)）。
 *
 * ⚠️ **`audit_logs` 一直在写，却没有出口** ——
 *    「哪些工具被批准过」「配置什么时候改的」「哪条记忆被拒了」，
 *    这些问题以前**只能直接查库**。
 *
 * ```bash
 * yarn audit:logs                              # 最近 50 条
 * yarn audit:logs --event TOOL_APPROVED        # 按事件名筛
 * yarn audit:logs --target tool                # 按目标类型筛
 * yarn audit:logs --since 2026-10-01           # 按时间筛
 * yarn audit:logs --limit 200
 * ```
 */

/** 命令行参数 */
function parseArgs(argv: string[]): {
  event?: string;
  target?: string;
  since?: string;
  limit: number;
} {
  const out: { event?: string; target?: string; since?: string; limit: number } = { limit: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--event' && next) {
      out.event = next;
      i += 1;
    } else if (arg === '--target' && next) {
      out.target = next;
      i += 1;
    } else if (arg === '--since' && next) {
      out.since = next;
      i += 1;
    } else if (arg === '--limit' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) out.limit = Math.min(parsed, 1000);
      i += 1;
    }
  }
  return out;
}

/** 一行审计（**给人看的**） */
function formatRow(row: AuditLog): string {
  const target = row.target_type
    ? ` · ${row.target_type}${row.target_id ? `:${row.target_id.slice(0, 12)}` : ''}`
    : '';
  const details = row.details ? ` · ${row.details.slice(0, 120)}` : '';
  return `${row.created_at}  ${row.action}${target}${details}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initDatabase();

  const conditions: Record<string, unknown>[] = [];
  if (args.event) conditions.push({ action: args.event });
  if (args.target) conditions.push({ target_type: args.target });
  if (args.since) conditions.push({ created_at: { [Op.gte]: args.since } });

  const rows = await AuditLog.findAll({
    where: conditions.length > 0 ? { [Op.and]: conditions } : {},
    order: [['created_at', 'DESC']],
    limit: args.limit,
  });

  if (rows.length === 0) {
    console.info('（没有符合条件的审计记录）');
    return;
  }

  console.info(`共 ${rows.length} 条：`);
  for (const row of rows) console.info(formatRow(row));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '查询审计日志失败');
    process.exit(1);
  });
}
