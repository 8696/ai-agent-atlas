import { initDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';
import { searchAll } from '../src/services/search.js';

/**
 * 跨会话检索的命令行 —— `yarn search <关键词>`
 * （见 [12-d D3](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ```bash
 * yarn search 数据库
 * yarn search "怎么配的"
 * ```
 *
 * 📌 **直接看命中** —— 检索的另一半（LLM 摘要）在对话里自动做。
 * ⚠️ **FTS5 不可用时退回时间倒序** —— 输出里会标出来。
 */

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('用法：yarn search <关键词>');
    process.exit(1);
  }

  await initDatabase();
  const { hits, degraded, reason } = await searchAll(query, { topK: 10 });

  if (degraded) {
    console.info(`⚠️ 全文索引不可用（${reason ?? '未知原因'}）—— 以下按时间倒序：\n`);
  }

  if (hits.length === 0) {
    console.info('（没有命中）');
    return;
  }

  console.info(`共 ${hits.length} 条命中：\n`);
  for (const hit of hits) {
    const where = hit.kind === 'memory' ? '记忆' : `会话 ${(hit.sessionId ?? '').slice(0, 8)}`;
    console.info(`· [${where}] ${hit.title}`);
    console.info(`  ${hit.snippet}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '检索失败');
    process.exit(1);
  });
}
