import { config } from './config.js';
import { logger } from './logger.js';
import { initDatabase } from './db.js';
import { createApp } from './app.js';
import { describeBoundary } from './lib/boundary.js';
import { getToolRegistry } from './tools/registry.js';
import { initMcp } from './tools/mcp/manager.js';
import { ensureFtsTables } from './lib/fts.js';
import { syncMemoryIndex } from './services/memory/store.js';
import { reloadSkills, syncSkillIndex } from './skills/store.js';
import { auditConfigOnStartup, auditSkillInstalls } from './services/config-audit.js';
import { purgeExpiredSessions } from './services/session.js';
import { startCronScheduler, stopCronScheduler } from './services/cron/scheduler.js';

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

  // ⚠️ **技能先扫描** —— 技能名冲突 / 装错了要在启动时就失败，
  //    别等第一次对话才发现（见 [12-c C4](./docs/12-c-需求-工具技能与扩展.md)）
  try {
    const skills = reloadSkills();
    logger.info(
      { count: skills.length, skills: skills.map((skill) => skill.meta.name) },
      '技能已加载',
    );
    // 📌 **新装的技能记一条审计** —— 见 [12-e E4](./docs/12-e-需求-观测安全与验收.md)
    await auditSkillInstalls(skills);
  } catch (err) {
    console.error(
      `\n[Atlas] 技能初始化失败：${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // ⚠️ **MCP 先连** —— 外部 server 的工具要进工具池，
  //    连不上只记日志，不影响其它工具（见 [12-c C5](./docs/12-c-需求-工具技能与扩展.md)）
  try {
    await initMcp();
  } catch (err) {
    logger.error({ err }, 'MCP 初始化失败 —— 其它功能不受影响');
  }

  // ⚠️ **启动即校验工具池** —— 两个内置工具重名是代码错误，
  //    **启动就失败**，不要等第一次对话才发现（见 [12-c C1](./docs/12-c-需求-工具技能与扩展.md)）
  try {
    const registry = getToolRegistry();
    logger.info({ count: registry.list().length, tools: registry.names() }, '工具池已就绪');
  } catch (err) {
    console.error(
      `\n[Atlas] 工具池初始化失败：${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // ⚠️ **会话保留期清理** —— 超期的会话连同消息一起清掉（见 [12-b B2](./docs/12-b-需求-对话与编排.md)）
  try {
    const purged = await purgeExpiredSessions(config.SESSION_RETENTION_DAYS);
    if (purged > 0) logger.info({ purged }, 'purged expired sessions');
  } catch (err) {
    logger.error({ err }, 'failed to purge expired sessions');
  }

  // 📌 **全文索引就绪** —— 跨会话检索靠它（见 [12-d D3](./docs/12-d-需求-记忆与配置.md)）
  //    ⚠️ **不可用就降级**（退回时间倒序）—— 不能因为检索挂了就起不来
  try {
    const probe = await ensureFtsTables();
    if (probe.available) {
      logger.info({ trigram: probe.trigram }, 'FTS 全文索引已就绪');
      await syncMemoryIndex();
      // 📌 **技能索引一起重建** —— 技能在文件里，改了文件就要重建
      await syncSkillIndex();
    } else {
      logger.warn({ reason: probe.reason }, 'FTS5 不可用 —— 跨会话检索退回时间倒序');
    }
  } catch (err) {
    logger.warn({ err }, 'FTS 索引初始化失败 —— 跨会话检索退回时间倒序');
  }

  // 📌 **配置审计** —— 启动时记一条 `CONFIG_LOADED` + 提示词变更
  //    （见 [12-a A5](./docs/12-a-需求-应用外壳与上下文.md)）
  await auditConfigOnStartup();

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT }, 'atlas backend listening');
    printBoundaryNotice();
  });

  // 📌 **定时任务调度器** —— 每分钟检查一次到期任务
  //    （见 [12-b B11](./docs/12-b-需求-对话与编排.md)）
  startCronScheduler();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      stopCronScheduler();
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
