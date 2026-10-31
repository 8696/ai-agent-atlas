import { Op } from 'sequelize';
import { initDatabase } from '../src/db.js';
import { ToolCallLog } from '../src/models/tool-call-log.model.js';
import { logger } from '../src/logger.js';

/**
 * 工具调用流水查询 —— `yarn tool:logs`
 * （见 [12-c C6](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **本期没有流水筛选界面** —— 查询走命令行。
 *
 * ```bash
 * yarn tool:logs                              # 最近 50 条
 * yarn tool:logs --tool shell                 # 按工具名筛
 * yarn tool:logs --status rejected            # 按状态筛
 * yarn tool:logs --since 2026-10-01           # 按时间筛
 * yarn tool:logs --limit 200
 * ```
 */

/** 命令行参数 */
function parseArgs(argv: string[]): {
  tool?: string;
  status?: string;
  since?: string;
  limit: number;
} {
  const out: { tool?: string; status?: string; since?: string; limit: number } = { limit: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--tool' && next) {
      out.tool = next;
      i += 1;
    } else if (arg === '--status' && next) {
      out.status = next;
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

/** 一行流水（**给人看的**） */
function formatRow(row: ToolCallLog): string {
  const confirm = row.requires_confirmation === 1 ? ' · 需确认' : '';
  const error = row.error ? ` · ${row.error.slice(0, 80)}` : '';
  return (
    `${row.created_at}  ${row.tool_name}（${row.source}）  ${row.status}` +
    `  ${row.duration_ms}ms  会话 ${row.session_id.slice(0, 8)}${confirm}${error}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initDatabase();

  const conditions: Record<string, unknown>[] = [];
  if (args.tool) conditions.push({ tool_name: args.tool });
  if (args.status) conditions.push({ status: args.status });
  if (args.since) conditions.push({ created_at: { [Op.gte]: args.since } });

  const rows = await ToolCallLog.findAll({
    where: conditions.length > 0 ? { [Op.and]: conditions } : {},
    order: [['created_at', 'DESC']],
    limit: args.limit,
  });

  if (rows.length === 0) {
    console.info('（没有符合条件的流水）');
    return;
  }

  console.info(`共 ${rows.length} 条：`);
  for (const row of rows) console.info(formatRow(row));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '查询工具流水失败');
    process.exit(1);
  });
}
