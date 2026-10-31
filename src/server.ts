import { config } from './config.js';
import { logger } from './logger.js';
import { initDatabase } from './db.js';
import { createApp } from './app.js';
import { describeBoundary } from './lib/boundary.js';
import { getToolRegistry } from './tools/registry.js';
import { purgeExpiredSessions } from './services/session.js';

/**
 * 打印服务边界提示（见 [12-a A1](./docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **非回环必须是红色告警** —— 这是替代鉴权的唯一边界，
 * 白纸黑字一行字不够，得让人一眼看见。
 */
function printBoundaryNotice(): void {
  const notice = describeBoundary(config.HOST);
  if (!notice.danger) {
    console.info(`[Atlas] ${notice.message}`);
    return;
  }
  const red = '\u001b[31m';
  const reset = '\u001b[0m';
  console.error(`\n${red}╭─ Atlas 安全告警 ─────────────────────────────╮${reset}`);
  console.error(`${red}│ ${notice.message}${reset}`);
  console.error(`${red}╰──────────────────────────────────────────────╯${reset}\n`);
}

async function main() {
  await initDatabase();

  // ⚠️ **启动即校验工具池** —— 两个内置工具重名是代码错误，
  //    **启动就失败**，不要等第一次对话才发现（见 [12-c C1](./docs/12-c-需求-工具技能与扩展.md)）
  try {
    const registry = getToolRegistry();
    logger.info({ count: registry.list().length, tools: registry.names() }, '工具池已就绪');
  } catch (err) {
    console.error(`\n[Atlas] 工具池初始化失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // ⚠️ **会话保留期清理** —— 超期的会话连同消息一起清掉（见 [12-b B2](./docs/12-b-需求-对话与编排.md)）
  try {
    const purged = await purgeExpiredSessions(config.SESSION_RETENTION_DAYS);
    if (purged > 0) logger.info({ purged }, 'purged expired sessions');
  } catch (err) {
    logger.error({ err }, 'failed to purge expired sessions');
  }

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT }, 'atlas backend listening');
    printBoundaryNotice();
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
