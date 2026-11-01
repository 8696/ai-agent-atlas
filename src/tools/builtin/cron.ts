import { z } from 'zod';
import { parseScheduleToCron } from '../../services/cron/parse.js';
import {
  addCronTask,
  describeCronTask,
  findCronTask,
  loadCronTasks,
  removeCronTask,
  updateCronTask,
} from '../../services/cron/store.js';
import { parseArgs, schemas } from '../args.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * `cron` —— **对话内管理定时任务**
 * （见 [12-b B11](./docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **为什么要有这个工具** ——
 *    记忆已经能在对话里管（`memory` / `memory_forget`），
 *    定时任务却**只能在命令行**加（`yarn cron:add`）。
 *    用户说「每天 9 点提醒我看日报」，对话里做不到 —— 这是个明显的不对称。
 *
 * 📌 **结果写进当前会话** —— 定时任务跑完的产出落在用户正在聊的这个会话里。
 *
 * ⚠️ **不给「无人值守自动放行」的口子** ——
 *    `autoApprove` 等于「批准一次跑脚本」变成「批准它一直跑」，
 *    那是**高危**的权限提升 —— 敏感档是按工具定的、不是按参数定的，
 *    所以这个口子只能走命令行（`yarn cron:add --auto-approve shell`）。
 */

/** `cron` 的入参 */
const cronSchema = z.object({
  /** 要做什么 */
  action: z.enum(['list', 'add', 'remove', 'enable', 'disable']),
  /** 任务名（`add` 用） */
  name: schemas.text(100).optional(),
  /** 周期描述（`add` 用）—— 自然语言（「每天早上 9 点」）或 5 段 cron 表达式 */
  schedule: schemas.text(200).optional(),
  /** 任务指令（`add` 用）—— 跑的时候当用户消息发给 Agent */
  prompt: schemas.text(2000).optional(),
  /** 任务 id（`remove` / `enable` / `disable` 用） */
  id: schemas.text(64).optional(),
});

/** 列出所有任务 */
function listText(): string {
  const tasks = loadCronTasks();
  if (tasks.length === 0) return '（还没有定时任务）';
  const lines = tasks.map(
    (task) =>
      `- \`${task.id}\` · ${describeCronTask(task)}` +
      (task.autoApprove.length > 0
        ? ` · ⚠️ 自动放行：${task.autoApprove.join('、')}`
        : ''),
  );
  return [`共 ${tasks.length} 条定时任务：`, '', ...lines].join('\n');
}

export const cronTool: ToolDefinition = {
  name: 'cron',
  description:
    '管理定时任务（到点自动跑一条指令，结果写进当前会话）。' +
    'list 看现有的；add 加一条（schedule 用自然语言如「每天早上 9 点」，' +
    '也可以直接写 5 段 cron 表达式）；remove 删一条；enable / disable 启用停用。' +
    '⚠️ 定时任务只在本机进程运行时才会触发；' +
    '任务里要用的危险工具仍然要人确认 —— 无人值守时那一步会被跳过并记录。',
  schema: cronSchema,
  // 📌 **normal 档** —— 加一条定时任务不是危险操作
  //    （「无人值守自动放行」的口子**不给**，见文件头的注释）
  sensitivity: 'normal',
  source: 'builtin',
  enabled: true,
  executor: 'local',
  async invoke(args: unknown, context): Promise<ToolResult> {
    try {
      const input = parseArgs(cronSchema, args);

      if (input.action === 'list') {
        return { ok: true, output: listText() };
      }

      if (input.action === 'add') {
        if (!input.schedule) {
          return { ok: false, output: '加任务要给 schedule（周期描述或 cron 表达式）' };
        }
        if (!input.prompt) {
          return { ok: false, output: '加任务要给 prompt（到点要执行什么）' };
        }

        // ⚠️ **解析不出来也要把任务建出来** —— **原文保留在任务里**，
        //    用户改完 `data/cron.json` 里这条任务的 `cron` 字段就能启用；
        //    直接报错的话这条任务就**整个丢了**（用户白写一遍）
        let expression = '';
        let parseError = '';
        try {
          expression = await parseScheduleToCron(input.schedule);
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }

        const sessionId = context.sessionId ?? '';
        const task = addCronTask({
          name: input.name ?? input.schedule,
          schedule: input.schedule,
          cron: expression,
          prompt: input.prompt,
          sessionId,
          // ⚠️ **解析失败 → 建好但先不启用** —— 别让它每分钟去撞一次不存在的表达式
          ...(parseError ? { enabled: false } : {}),
          ...(parseError ? { lastError: parseError } : {}),
        });

        if (parseError) {
          return {
            ok: false,
            output:
              `周期描述解析失败：${parseError}\n` +
              `任务**已建好但未启用** —— 原文保留在 \`${input.schedule}\` 里（任务 id：${task.id}）。\n` +
              '改 `data/cron.json` 里这条任务的 `cron` 字段就能启用。',
            error: 'CRON_PARSE_FAILED',
            data: { id: task.id, enabled: false, reason: parseError },
          };
        }
        return {
          ok: true,
          output:
            `已加定时任务：${task.id}\n${describeCronTask(task)}\n` +
            '（结果会写进当前会话。任务里要用的危险工具仍然要人确认 —— 无人值守时那一步会被跳过并记录。）',
          data: { id: task.id, cron: task.cron, enabled: task.enabled },
        };
      }

      // ── remove / enable / disable ──
      if (!input.id) {
        return { ok: false, output: `${input.action} 要给任务 id（先跑 cron list 看）` };
      }
      const task = findCronTask(input.id);
      if (!task) {
        return { ok: false, output: `没有这个定时任务：${input.id}` };
      }

      if (input.action === 'remove') {
        const ok = removeCronTask(input.id);
        return {
          ok,
          output: ok ? `已删掉定时任务「${task.name}」。` : `删不掉：${input.id}`,
          data: { id: input.id, removed: ok },
        };
      }

      const updated = updateCronTask(input.id, { enabled: input.action === 'enable' });
      return {
        ok: true,
        output: updated
          ? `已${input.action === 'enable' ? '启用' : '停用'}定时任务「${task.name}」。\n${describeCronTask(updated)}`
          : `改不了：${input.id}`,
        data: { id: input.id, enabled: updated?.enabled ?? false },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `定时任务操作失败：${message}`, error: message };
    }
  },
};

/** 定时任务工具组 */
export function cronToolGroups(): Array<{ source: 'builtin'; tools: ToolDefinition[] }> {
  return [{ source: 'builtin', tools: [cronTool] }];
}
