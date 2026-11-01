import { nanoid } from 'nanoid';
import { HumanMessage } from '@langchain/core/messages';
import { isInterrupted } from '@langchain/langgraph';
import { getGraph } from '../../agent/graph.js';
import { getCheckpointSaver } from '../../agent/checkpointer.js';
import { logger } from '../../logger.js';
import { writeAudit } from '../../lib/audit.js';
import { appendAssistantMessage, appendUserMessage } from '../message.js';
import { createSession, findSession } from '../session.js';
import { logEvent } from '../turn-log/emit.js';
import { finishTurn, startTurn } from '../turn-log/store.js';
import type { CronTask } from './store.js';

/**
 * 定时任务的执行 —— **跑一次完整的图**（见 [12-b B11](./docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **复用同一套编排与工具池** —— 定时任务跟用户聊天没有本质区别，
 * 只是「没人盯着」。
 *
 * ⚠️ **无人值守的确认闸** —— 任务里若触发高危工具要确认：
 * **跳过该步并记录**，**不能挂死**（没有人会来点批准）。
 * 可在任务里显式声明 `autoApprove` 放行（**高危，要显式写出来**）。
 */

/** 一次运行的结果 */
export interface CronRunResult {
  /** 跑成功了吗 */
  ok: boolean;
  /** Agent 的回答 */
  text: string;
  /** 是不是因为要人工确认而跳过 */
  skipped: boolean;
  /** 跳过 / 失败的原因 */
  reason: string;
}

/** 子图的 thread_id（**每个任务一个** —— 别跟聊天会话抢检查点） */
function cronThreadId(task: CronTask): string {
  return `cron:${task.id}`;
}

/**
 * 跑一个定时任务。
 *
 * ⚠️ **不抛异常** —— 失败也要把任务状态记下来（不然下次一直重试）。
 */
export async function runCronTask(task: CronTask): Promise<CronRunResult> {
  // ── 会话没了就重建一个（**任务不该因为会话被删就彻底哑掉**） ──
  let sessionId = task.sessionId;
  if (!sessionId || !(await findSession(sessionId))) {
    const session = await createSession({ title: `定时任务 · ${task.name}` });
    sessionId = session.id;
  }

  const messageId = nanoid();
  await appendUserMessage(sessionId, task.prompt);

  // 📌 **定时任务也进会话日志**（见 [12-e E7](../docs/12-e-需求-观测安全与验收.md)）
  //    ⚠️ **它不走网关** —— 网关那步「开一轮」在这里补上，
  //    不开的话事件会成孤儿（有事件没有轮次 → 日志里看不见）
  await startTurn({ turnId: messageId, sessionId });
  logEvent({
    turnId: messageId,
    sessionId,
    type: 'request.received',
    eventKey: 'request.received',
    title: `定时任务：${task.name}`,
    payload: {
      taskId: task.id,
      task: task.name,
      prompt: task.prompt,
      autoApprove: task.autoApprove ?? [],
    },
  });

  let text = '';
  let interrupted = false;

  try {
    const graph = getGraph();
    const stream = (await graph.stream(
      {
        turnMessages: [new HumanMessage(task.prompt)],
        sessionId,
        messageId,
        // 📌 **显式放行的工具** —— 无人值守时这些不弹确认
        autoApprove: task.autoApprove,
        // 📌 **用量记到 `cron` 桶** —— 定时任务花了多少要单独看得见
        //    （见 [12-b B11](../../docs/12-b-需求-对话与编排.md)）
        usageScope: 'cron',
      },
      {
        configurable: { thread_id: cronThreadId(task) },
        streamMode: ['custom', 'values'] as never,
      },
    )) as unknown as AsyncIterable<unknown>;

    for await (const chunk of stream) {
      const [mode, payload] = chunk as [string, unknown];
      if (mode !== 'values') continue;

      if (isInterrupted(payload)) {
        // ⚠️ **要人工确认 → 停在这里** —— 没人会来批准，不能挂死
        interrupted = true;
        break;
      }
      const value = (payload ?? {}) as { finalText?: unknown };
      if (typeof value.finalText === 'string') text = value.finalText;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, task: task.id }, '定时任务跑失败了');
    await writeAudit('CRON_TRIGGERED', 'cron', task.id, {
      name: task.name,
      status: 'error',
      error: message,
    });
    await finishTurn(messageId, 'failed');
    logEvent({
      turnId: messageId,
      sessionId,
      type: 'turn.error',
      eventKey: 'turn.error',
      title: '定时任务失败',
      payload: { error: message },
    });
    return { ok: false, text: '', skipped: false, reason: message };
  }

  if (interrupted) {
    const reason = '因需人工确认已跳过';
    logger.warn({ task: task.id, name: task.name }, `定时任务「${task.name}」${reason}`);
    // ⚠️ **把这一趟的检查点删掉** ——
    //    否则下一次跑会从同一个挂起点恢复 → 又撞同一个 interrupt → 又跳过，
    //    每分钟重试一次，**这个任务永远产不出结果**。
    //    删掉之后下一趟从头跑（无人值守时该确认的工具还是要确认）。
    try {
      await getCheckpointSaver().deleteThread(cronThreadId(task));
    } catch (err) {
      logger.warn({ err, task: task.id }, '清理定时任务的检查点失败 —— 下次可能还会撞同一个挂起');
    }
    await writeAudit('CRON_TRIGGERED', 'cron', task.id, {
      name: task.name,
      status: 'skipped',
      reason,
    });
    // 📌 **这一轮是「跳过」不是「完成」** —— 别让它一直挂在「进行中」
    await finishTurn(messageId, 'failed');
    logEvent({
      turnId: messageId,
      sessionId,
      type: 'turn.error',
      eventKey: 'turn.error',
      title: '定时任务跳过',
      payload: { reason },
    });
    return { ok: false, text: '', skipped: true, reason };
  }

  await appendAssistantMessage(sessionId, {
    id: messageId,
    content: text,
    parts: [{ type: 'text', text }],
  });

  await writeAudit('CRON_TRIGGERED', 'cron', task.id, {
    name: task.name,
    status: 'success',
    sessionId,
  });

  // 📌 **这一轮跑完了** —— 图的 `answer` 节点也会写一次（幂等）
  await finishTurn(messageId, 'finished');

  return { ok: true, text, skipped: false, reason: '' };
}

/**
 * 手动跑一次（**CLI 用**）。
 *
 * 📌 **和调度器走同一个函数** —— 手动触发与到点触发行为一致。
 */
export async function triggerCronTask(task: CronTask): Promise<CronRunResult> {
  logger.info({ task: task.id, name: task.name }, '手动触发定时任务');
  return runCronTask(task);
}
