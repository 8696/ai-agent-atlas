import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { parseCronExpression, previousOccurrences } from './schedule.js';
import { runCronTask } from './runner.js';
import { loadCronTasks, updateCronTask, type CronTask } from './store.js';

/**
 * 定时任务调度器 —— **后台每分钟检查一次到期任务**
 * （见 [12-b B11](./docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **进程没跑就不会触发** —— 本地项目不做常驻服务保活。
 * 错过的时间点**默认跳过**，并在日志里记「错过了 N 次」。
 */

/** 定时器句柄 */
let timer: NodeJS.Timeout | undefined;

/** 正在跑（**防重入** —— 上一轮还没跑完就别再起一轮） */
let running = false;

/**
 * 检查一轮（**每分钟调一次**）。
 *
 * @param now 当前时间（**测试可注入**）
 */
export async function tickCron(now: Date = new Date()): Promise<void> {
  if (!config.CRON_ENABLED) return;
  if (running) {
    logger.debug('上一轮定时任务还没跑完 —— 跳过这一轮');
    return;
  }
  running = true;
  try {
    const tasks = loadCronTasks();
    for (const task of tasks) {
      try {
        await checkTask(task, now);
      } catch (err) {
        logger.error(
          { err, task: task.id, name: task.name },
          '定时任务检查失败 —— 不影响别的任务',
        );
      }
    }
  } finally {
    running = false;
  }
}

/** 检查一个任务到没到点 */
async function checkTask(task: CronTask, now: Date): Promise<void> {
  if (!task.enabled) return;

  const fields = parseCronExpression(task.cron);
  if (!fields) {
    // ⚠️ **表达式坏了 → 明确报出来** —— 不静默跳过
    logger.error({ task: task.id, cron: task.cron }, `定时任务「${task.name}」的 cron 表达式不合法`);
    updateCronTask(task.id, { lastStatus: 'error', lastError: `cron 表达式不合法：${task.cron}` });
    return;
  }

  const currentMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  const occurrences = previousOccurrences(fields, now, { timeZone: config.TIMEZONE });
  const dueNow = occurrences.includes(currentMinute);

  const lastRunAt = task.lastRunAt ? new Date(task.lastRunAt).getTime() : 0;

  // ⚠️ **错过的时间点默认跳过** —— 只记一笔日志，不补跑
  const missed = occurrences.filter((time) => time > lastRunAt && time < currentMinute).length;
  if (missed > 0) {
    logger.warn(
      { task: task.id, name: task.name, missed },
      `定时任务「${task.name}」错过了 ${missed} 次 —— 已跳过（进程没跑的时候不会触发）`,
    );
  }

  if (!dueNow) {
    // 📌 **只推进时间戳，不改状态** —— 免得把「跳过」记成「失败」
    if (missed > 0) updateCronTask(task.id, { lastRunAt: now.toISOString() });
    return;
  }

  // ⚠️ **同一分钟不重复跑**
  if (lastRunAt && Math.floor(lastRunAt / 60_000) === currentMinute) return;

  logger.info({ task: task.id, name: task.name }, `定时任务「${task.name}」到点了`);
  const result = await runCronTask(task);

  updateCronTask(task.id, {
    lastRunAt: now.toISOString(),
    lastStatus: result.skipped ? 'skipped' : result.ok ? 'success' : 'error',
    lastError: result.reason,
  });

  if (result.ok) {
    logger.info({ task: task.id }, `定时任务「${task.name}」跑完了`);
  } else {
    logger.error(
      { task: task.id, name: task.name, reason: result.reason },
      `定时任务「${task.name}」没跑成`,
    );
  }
}

/**
 * 启动调度器（**服务起来时调**）。
 *
 * 📌 **对齐到整分钟** —— 定时器漂到 09:00:59 就会错过 09:00 那一档。
 */
export function startCronScheduler(): void {
  if (!config.CRON_ENABLED) {
    logger.info('定时任务调度器没开（CRON_ENABLED=false）');
    return;
  }
  if (timer) return;

  const scheduleNext = (): void => {
    const now = Date.now();
    // 📌 **下一分钟开头 + 200ms** —— 让本地分钟数对齐
    const nextAt = Math.ceil(now / 60_000) * 60_000 + 200;
    timer = setTimeout(() => {
      void tickCron().finally(scheduleNext);
    }, Math.max(nextAt - now, 1000));
  };

  // 📌 **先查一轮** —— 启动时把「错过几次」记下来
  void tickCron();
  scheduleNext();
  logger.info('定时任务调度器已启动（每分钟检查一次）');
}

/** 停掉调度器（**关服务时调**） */
export function stopCronScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}
