import { QueryTypes } from 'sequelize';
import { initDatabase, sequelize } from '../src/db.js';
import { collectOrphanThreads } from '../src/agent/checkpointer.js';
import { logger } from '../src/logger.js';

/**
 * 清理测试残留 —— `yarn data:clean`（见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ```bash
 * yarn data:clean            # 干跑 —— 只报要删什么
 * yarn data:clean --yes      # 真删
 * yarn data:clean --yes --vacuum   # 真删 + 重建库文件（把空闲页还给磁盘）
 * ```
 *
 * ⚠️ **为什么会有残留** —— 集成测试早期直接写业务库，
 *    后来改成「每个测试文件一个临时库」（见 `tests/fixtures/db.ts`），
 *    但**当初写进去的行还留在库里**。
 *    后果不是「难看」—— 是**预算被吃掉了**：
 *    测试产生的 token 记在同一个 `cost_logs` 里，月度预算算的是它们的和。
 *
 * 📌 **只删「可证明是测试产物」的行** —— 判定依据写死在下：
 *    ① `cost_logs.model = 'fake-model'` —— 集成测试里的假模型名
 *    ② **没有任何消息**的会话 —— 测试建了会话但没发消息
 *    ③ 测试夹具的工具名（`demo__echo` 等）
 *
 * ⚠️ **删之前先备份** —— `yarn backup`。
 */

/** 集成测试里的假模型名（`tests/integration/*` 的 mock 都用这个） */
const TEST_MODEL = 'fake-model';

/** 测试夹具里的工具名（`tests/fixtures/mcp-server.ts` 提供的那个） */
const TEST_TOOL_NAMES = ['demo__echo'];

/** 一批要删的行 */
interface CleanupPlan {
  /** 要删的 cost_logs 条数 */
  costLogs: number;
  /** 要删的 cost_logs 占掉的 token */
  costTokens: number;
  /** 要删的会话 */
  sessions: number;
  /** 要删的工具流水 */
  toolLogs: number;
  /** 受影响的月份（**提示用**） */
  months: string[];
  /** 孤儿 thread 的检查点（**会话早没了、检查点还在**） */
  orphanCheckpoints: number;
}

/** 先看清要删什么，再决定删不删 */
async function plan(): Promise<CleanupPlan> {
  const costRows = await sequelize.query<{ n: number; tok: number; ym: string }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tok,
            MIN(substr(created_at, 1, 7)) AS ym
       FROM cost_logs
      WHERE model = :model`,
    { type: QueryTypes.SELECT, replacements: { model: TEST_MODEL } },
  );
  const monthRows = await sequelize.query<{ ym: string }>(
    `SELECT DISTINCT substr(created_at, 1, 7) AS ym FROM cost_logs WHERE model = :model`,
    { type: QueryTypes.SELECT, replacements: { model: TEST_MODEL } },
  );

  const sessionRows = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM sessions s
      WHERE COALESCE(s.title, '') = ''
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`,
    { type: QueryTypes.SELECT },
  );

  const toolRows = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tool_call_logs WHERE tool_name IN (:names)`,
    { type: QueryTypes.SELECT, replacements: { names: TEST_TOOL_NAMES } },
  );

  const orphanRows = await sequelize.query<{ n: number }>(
    `SELECT COUNT(DISTINCT thread_id) AS n
       FROM graph_checkpoints
      WHERE type = 'checkpoint'
        AND thread_id NOT LIKE 'subagent:%'
        AND thread_id NOT IN (SELECT id FROM sessions)`,
    { type: QueryTypes.SELECT },
  );

  const cost = costRows[0];
  return {
    costLogs: Number(cost?.n ?? 0),
    costTokens: Number(cost?.tok ?? 0),
    sessions: Number(sessionRows[0]?.n ?? 0),
    toolLogs: Number(toolRows[0]?.n ?? 0),
    months: monthRows.map((row) => row.ym).filter((ym) => ym !== ''),
    orphanCheckpoints: Number(orphanRows[0]?.n ?? 0),
  };
}

/**
 * 「可证明是测试产物」的那批空会话（**删之前要先算出来**）。
 *
 * 📌 **为什么不能边删边查** ——
 * `DELETE FROM sessions WHERE ...` 一执行，
 * 后面的 `WHERE session_id IN (SELECT id FROM sessions ...)` 就查不到了。
 */
const EMPTY_TEST_SESSIONS = `SELECT id FROM sessions
                              WHERE COALESCE(title, '') = ''
                                AND NOT EXISTS (
                                  SELECT 1 FROM messages m WHERE m.session_id = sessions.id
                                )`;

/** 真删 */
async function apply(): Promise<void> {
  await sequelize.query(
    `DELETE FROM cost_logs WHERE model = :model`,
    { replacements: { model: TEST_MODEL } },
  );
  await sequelize.query(
    `DELETE FROM tool_call_logs WHERE tool_name IN (:names)`,
    { replacements: { names: TEST_TOOL_NAMES } },
  );

  // 📌 **删会话要连带删它的东西** ——
  //    直接用 SQL 删会话行会绕过 `deleteSession` 的那套清理，
  //    于是检查点 / 工具流水全成了孤儿
  //    （实测：本机库 452 个会话 thread 里有 440 个是孤儿，占掉 3.3 MB）。
  await sequelize.query(
    `DELETE FROM tool_call_logs WHERE session_id IN (${EMPTY_TEST_SESSIONS})`,
  );
  await sequelize.query(
    `DELETE FROM graph_checkpoint_writes WHERE thread_id IN (${EMPTY_TEST_SESSIONS})`,
  );
  await sequelize.query(
    `DELETE FROM graph_checkpoints WHERE thread_id IN (${EMPTY_TEST_SESSIONS})`,
  );
  await sequelize.query(`DELETE FROM sessions WHERE id IN (${EMPTY_TEST_SESSIONS})`);

  // 📌 **再收一遍历史留下的孤儿** —— 会话早没了、检查点还在的那些
  const orphans = await collectOrphanThreads();
  if (orphans > 0) logger.info({ orphans }, '孤儿会话的图检查点已回收');

  // 📌 **重建库文件，把空闲页还给磁盘** ——
  //    SQLite 删行只把页标成「空闲」，**文件不会自己变小**。
  //    删了一堆行之后文件还是那么大（实测：清完 3.4 MB 的检查点，
  //    文件还是 11 MB —— 那 7.6 MB 是空闲页）。
  if (process.argv.includes('--vacuum')) {
    console.info('  重建库文件（VACUUM）…');
    await sequelize.query('VACUUM');
  }
}

async function main(): Promise<void> {
  await initDatabase();

  const confirmed = process.argv.includes('--yes');
  const before = await plan();

  console.info('**测试残留盘点**');
  console.info(`  cost_logs（模型 = ${TEST_MODEL}）：${before.costLogs} 条`);
  console.info(`    占掉的 token：${before.costTokens}`);
  console.info(`  空会话（没有任何消息）：${before.sessions} 个`);
  console.info(`  工具流水（夹具工具）：${before.toolLogs} 条`);
  console.info(`  孤儿检查点（会话早没了）：${before.orphanCheckpoints} 个会话`);
  if (before.months.length > 0) {
    console.info(`  涉及月份：${before.months.join('、')}`);
  }

  if (
    before.costLogs === 0 &&
    before.sessions === 0 &&
    before.toolLogs === 0 &&
    before.orphanCheckpoints === 0
  ) {
    console.info('\n✅ 没有测试残留 —— 库里是干净的。');
    return;
  }

  if (!confirmed) {
    console.info('\n（干跑 —— 什么也没删。确认要删就加 `--yes`）');
    console.info('💡 **顺带把空闲页还给磁盘** —— 加 `--vacuum`（重建库文件，删完再跑）');
    console.info('⚠️ **删之前建议先 `yarn backup`** —— 备份在 `backups/`。');
    return;
  }

  console.info('\n删除中…');
  await apply();
  const after = await plan();
  console.info(
    `✅ 删完了 —— cost_logs 少了 ${before.costLogs - after.costLogs} 条，` +
      `空会话少了 ${before.sessions - after.sessions} 个。`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '清理测试残留失败');
    process.exit(1);
  });
}
