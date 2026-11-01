import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { FILES } from '../../config/paths.js';
import { logger } from '../../logger.js';
import { writeAudit } from '../../lib/audit.js';

/**
 * 定时任务的读写 —— **任务描述存在 `data/cron.json`**
 * （见 [12-b B11](./docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **文件，不是数据库、不是界面** —— 任务少、手改方便、跟着 git 走。
 * ⚠️ **原子写** —— 写一半崩了不能把任务表弄坏（那等于丢用户的定时任务）。
 */

/** 一次运行的结果 */
export type CronRunStatus = 'success' | 'error' | 'skipped' | '';

/** 一个定时任务 */
export interface CronTask {
  /** 任务 id */
  id: string;
  /** 名字（**给人看的**） */
  name: string;
  /** 自然语言描述（如「每天早上 9 点」） */
  schedule: string;
  /** 解析出来的 cron 表达式（**存下来，不每次重解析**） */
  cron: string;
  /** 任务指令（**跑的时候当用户消息发给 Agent**） */
  prompt: string;
  /** 是否启用 */
  enabled: boolean;
  /** 结果写进哪个会话 */
  sessionId: string;
  /**
   * 允许自动放行的工具（**显式写出来才放行**）。
   *
   * ⚠️ **高危** —— 无人值守时高危工具本来要确认，
   *    在这里列出来就等于「自动批准」。
   */
  autoApprove: string[];
  /** 创建时间 */
  createdAt: string;
  /** 上次运行时间 */
  lastRunAt: string;
  /** 上次运行结果 */
  lastStatus: CronRunStatus;
  /** 上次失败原因 */
  lastError: string;
}

/** 任务表文件 */
interface CronFile {
  tasks: CronTask[];
}

/**
 * 读任务表。
 *
 * ⚠️ **文件坏了不要炸** —— 返回空表 + 记日志。
 *    定时任务挂掉不该让整个 Agent 起不来。
 */
export function loadCronTasks(path: string = FILES.cron): CronTask[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    logger.error({ err, path }, '定时任务表读不出来 —— 当成空表');
    return [];
  }
  if (raw.trim() === '') return [];

  try {
    const parsed = JSON.parse(raw) as Partial<CronFile>;
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    return tasks.filter((task): task is CronTask => Boolean(task && typeof task.id === 'string'));
  } catch (err) {
    logger.error({ err, path }, '定时任务表不是合法 JSON —— 当成空表');
    return [];
  }
}

/** 原子写 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败就算了 —— 真正的错误在下面抛
    }
    throw err;
  }
}

/** 写任务表 */
export function saveCronTasks(tasks: CronTask[], path: string = FILES.cron): void {
  atomicWrite(path, `${JSON.stringify({ tasks }, null, 2)}\n`);
}

/** 按 id 找任务 */
export function findCronTask(id: string, tasks?: CronTask[]): CronTask | undefined {
  return (tasks ?? loadCronTasks()).find((task) => task.id === id);
}

/**
 * 加一个任务。
 *
 * ⚠️ **`lastRunAt` 记成现在** —— 免得把「创建之前就该跑的次数」算成错过。
 */
export function addCronTask(
  input: {
    name: string;
    schedule: string;
    cron: string;
    prompt: string;
    sessionId: string;
    enabled?: boolean | undefined;
    autoApprove?: string[] | undefined;
    /**
     * 上一轮的错误（**新建时就带上** —— 解析失败的任务要留着原文与原因）。
     */
    lastError?: string | undefined;
  },
  path: string = FILES.cron,
): CronTask {
  const tasks = loadCronTasks(path);
  const now = new Date().toISOString();
  const task: CronTask = {
    id: nanoid(),
    name: input.name.trim() || input.schedule.trim(),
    schedule: input.schedule.trim(),
    cron: input.cron.trim(),
    prompt: input.prompt.trim(),
    enabled: input.enabled ?? true,
    sessionId: input.sessionId,
    autoApprove: input.autoApprove ?? [],
    createdAt: now,
    lastRunAt: now,
    lastStatus: '',
    lastError: input.lastError ?? '',
  };
  tasks.push(task);
  saveCronTasks(tasks, path);
  void writeAudit('CRON_CREATED', 'cron', task.id, {
    name: task.name,
    schedule: task.schedule,
    cron: task.cron,
    sessionId: task.sessionId,
  });
  return task;
}

/** 删一个任务 */
export function removeCronTask(id: string, path: string = FILES.cron): boolean {
  const tasks = loadCronTasks(path);
  const next = tasks.filter((task) => task.id !== id);
  if (next.length === tasks.length) return false;
  saveCronTasks(next, path);
  return true;
}

/** 改一个任务 */
export function updateCronTask(
  id: string,
  patch: Partial<Omit<CronTask, 'id'>>,
  path: string = FILES.cron,
): CronTask | undefined {
  const tasks = loadCronTasks(path);
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) return undefined;
  const updated: CronTask = { ...(tasks[index] as CronTask), ...patch, id };
  tasks[index] = updated;
  saveCronTasks(tasks, path);
  return updated;
}

/** 任务写进一行（**给 CLI 看**） */
export function describeCronTask(task: CronTask): string {
  const state = task.enabled ? '启用' : '停用';
  const last = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString('zh-CN') : '还没跑过';
  const status = task.lastStatus ? ` · 上次${task.lastStatus}` : '';
  return (
    `${task.name} · ${state} · ${task.schedule}（${task.cron}）· 会话 ${task.sessionId} · 上次 ${last}${status}`
  );
}
