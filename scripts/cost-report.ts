import { QueryTypes } from 'sequelize';
import { initDatabase, sequelize } from '../src/db.js';
import { logger } from '../src/logger.js';
import { checkBudget, monthlyUsage, sessionUsage } from '../src/services/cost.js';

/**
 * 成本记账的命令行 —— `yarn cost:report`
 * （见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ```bash
 * yarn cost:report                    # 本月
 * yarn cost:report --session <id>     # 某个会话
 * ```
 *
 * ⚠️ **不做成本分析报表** —— 本地单用户靠 provider 侧的账单就够了；
 * 这里只是「看一眼钱花在哪」。
 */

/** 按用途拆开看 */
async function byScope(): Promise<
  Array<{ scope: string; entries: number; tokens: number; cost: number }>
> {
  const rows = await sequelize.query<{
    scope: string;
    entries: number;
    tokens: number;
    cost: number;
  }>(
    `SELECT usage_scope AS scope,
            COUNT(*) AS entries,
            COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
            COALESCE(SUM(cost), 0) AS cost
       FROM cost_logs
      GROUP BY usage_scope
      ORDER BY tokens DESC`,
    { type: QueryTypes.SELECT },
  );
  return rows;
}

async function main(): Promise<void> {
  await initDatabase();

  const sessionIndex = process.argv.indexOf('--session');
  const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;

  const month = await monthlyUsage();
  const budget = await checkBudget();

  console.info('**本月**');
  console.info(`  输入 token：${month.inputTokens}`);
  console.info(`  输出 token：${month.outputTokens}`);
  console.info(
    `  合计：${month.totalTokens} / 预算 ${budget.budget}（${Math.round(budget.ratio * 100)}%）`,
  );
  console.info(`  费用：$${month.costUsd.toFixed(4)}`);
  console.info(`  调用次数：${month.entries}`);

  if (month.costUsd === 0) {
    console.info('  （费用是 0 —— 单价没配，填 `data/pricing.json` 就有数字了）');
  }
  if (budget.warn) {
    console.info(`  ⚠️ 已超过告警线（${Math.round(budget.ratio * 100)}%）`);
  }

  const scopes = await byScope();
  if (scopes.length > 0) {
    console.info('\n**按用途**');
    for (const scope of scopes) {
      console.info(
        `  ${scope.scope.padEnd(10)} ${scope.tokens} token · ${scope.entries} 次 · $${scope.cost.toFixed(4)}`,
      );
    }
  }

  if (sessionId) {
    const session = await sessionUsage(sessionId);
    console.info(`\n**会话 ${sessionId.slice(0, 8)}**`);
    console.info(
      `  ${session.totalTokens} token（输入 ${session.inputTokens} / 输出 ${session.outputTokens}）`,
    );
    console.info(`  $${session.costUsd.toFixed(4)} · ${session.entries} 次调用`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '成本报表失败');
    process.exit(1);
  });
}
