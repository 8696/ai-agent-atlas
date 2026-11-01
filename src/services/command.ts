import { Op } from 'sequelize';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, paths } from '../config.js';
import { logger } from '../logger.js';
import { sequelize } from '../db.js';
import { Message } from '../models/message.model.js';
import { checkBudget, monthlyUsage, sessionUsage } from './cost.js';
import { stopSessionStream } from './chat.js';
import { resolveFallback, resolveModel } from './model.js';
import { listPersonalities } from './prompt.js';
import { getSkills } from '../skills/store.js';
import {
  clearMemory,
  deleteMemory,
  listMemories,
  memoryUsageHeader,
} from './memory/index.js';
import type { MemoryFile } from './memory/types.js';
import { compressSession, loadSessionMessages } from './session-summary.js';
import { buildContextReport, renderContextReport } from './context-report.js';
import { describeCronTask, loadCronTasks } from './cron/store.js';
import { exportSession } from './session-export.js';
import {
  createSession,
  findSession,
  getSessionSettings,
  updateSessionMetadata,
} from './session.js';

/**
 * 斜杠命令 —— **服务端解析，零 LLM 调用**
 * （见 [12-b B9](../docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **命令不产生任何模型调用** —— 白花一次钱、还可能触发工具。
 * ⚠️ **未知命令要明确报错** —— 绝不把它当成普通消息发给模型。
 */

/** 一条命令的说明 */
export interface CommandSpec {
  /** 命令名（**不含斜杠**） */
  name: string;
  /** 用法 */
  usage: string;
  /** 一句话说明 */
  summary: string;
}

/** 本期命令集（**对齐 Hermes 的会话命令**） */
export const COMMANDS: CommandSpec[] = [
  { name: 'help', usage: '/help', summary: '列出全部命令与用法' },
  { name: 'new', usage: '/new', summary: '新建会话' },
  { name: 'reset', usage: '/reset', summary: '清空当前会话的上下文（历史记录与工具流水保留）' },
  { name: 'model', usage: '/model [名称]', summary: '列出可用模型；带名称则切换本会话的模型' },
  {
    name: 'personality',
    usage: '/personality [文件名]',
    summary: '列出可用人格文件；带文件名则切换',
  },
  { name: 'retry', usage: '/retry', summary: '重新生成上一轮回答' },
  { name: 'undo', usage: '/undo', summary: '撤销上一轮（回退消息与图状态，不删会话）' },
  { name: 'compress', usage: '/compress', summary: '手动压缩当前会话上下文' },
  { name: 'usage', usage: '/usage', summary: '本月 token / 花费 / 本会话用量' },
  { name: 'memory', usage: '/memory [list|delete|clear]', summary: '查看长期记忆；删条目（/memory delete USER 名字）或清空（/memory clear USER）' },
  { name: 'skills', usage: '/skills', summary: '列出已安装技能' },
  { name: 'cron', usage: '/cron', summary: '列出定时任务' },
  {
    name: 'export',
    usage: '/export [md|json]',
    summary: '把当前会话导出成 Markdown（默认）或 JSON，文件落在 data/exports/',
  },
  {
    name: 'context',
    usage: '/context [问题]',
    summary: '看这一轮给模型发了什么（上下文构成报告；带问题则算动态段）',
  },
  { name: 'thinking', usage: '/thinking on|off', summary: '思考模式开关（下一轮生效）' },
  { name: 'stop', usage: '/stop', summary: '停止当前流式输出' },
];

/** 命令名集合 */
const COMMAND_NAMES = new Set(COMMANDS.map((command) => command.name));

/** 解析结果 */
export interface ParsedCommand {
  /** 命令名（**不含斜杠**） */
  name: string;
  /** 参数（**原样**） */
  args: string;
  /** 认得这个命令吗 */
  known: boolean;
}

/**
 * 解析一行斜杠命令。
 *
 * @returns 不是命令就返回 `null`
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (rawName ?? '').toLowerCase();
  if (!name) return null;
  return { name, args: rest.join(' ').trim(), known: COMMAND_NAMES.has(name) };
}

/** 命令执行的结果 */
export interface CommandResult {
  /** 给用户看的正文（**Markdown**） */
  text: string;
  /** 机器可读的载荷（**给前端用**） */
  data?: Record<string, unknown>;
  /** 前端接下来要做什么 */
  action?: 'none' | 'new-session' | 'retry' | 'undo' | 'refresh' | 'stop' | undefined;
}

/** 执行命令时的上下文 */
export interface CommandContext {
  /** 当前会话 id（**没有会话的命令也能跑**） */
  sessionId?: string | undefined;
}

/** `/help` 的正文 */
function helpText(): string {
  const lines = COMMANDS.map((command) => `- \`${command.usage}\` —— ${command.summary}`);
  return ['**可用命令**', '', ...lines, '', '命令在服务端解析，**不消耗任何 token**。'].join('\n');
}

/** 列出已安装技能（**读技能包本身** —— 不是扫目录名） */
function listSkills(): Array<{ name: string; description: string; scripts: number }> {
  try {
    return getSkills().map((skill) => ({
      name: skill.meta.name,
      description: skill.meta.description,
      scripts: skill.scripts.length,
    }));
  } catch {
    // ⚠️ **技能装错了也别让命令挂掉** —— 启动时才会因为装错而失败
    return [];
  }
}

/**
 * `/memory` 的正文 —— **列出记忆条目**。
 *
 * 📌 **只读的这一支没有确认问题** —— 看一眼不改变任何东西。
 */
function memoryListText(file?: MemoryFile): string {
  const items = listMemories(file);
  const lines = [
    '**长期记忆**',
    '',
    memoryUsageHeader(),
    '',
  ];
  if (items.length === 0) {
    lines.push('（还没有记忆条目）');
  } else {
    for (const item of items) {
      const flags = [
        item.entry.kind,
        item.entry.source === 'manual' ? '手动' : '自动',
        item.entry.status === 'archived' ? '已归档' : '',
        item.entry.updated || '',
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(`- [${item.file}] \`${item.entry.name}\`（${flags}）：${item.entry.body}`);
    }
  }
  lines.push('', '`/memory delete <MEMORY|USER> <名字>` 删一条 · `/memory clear <MEMORY|USER>` 清空一个文件');
  return lines.join('\n');
}

/** `/memory` 的用法提示 */
const MEMORY_USAGE = [
  '**用法**',
  '',
  '- `/memory` 或 `/memory list [MEMORY|USER]` —— 查看记忆条目',
  '- `/memory delete <MEMORY|USER> <名字>` —— 永久删掉一条',
  '- `/memory clear <MEMORY|USER>` —— 清空一个文件的所有条目（**不可恢复**）',
].join('\n');

/** 把参数解析成记忆文件（**只认 `MEMORY` / `USER`** —— 大小写不限） */
function toMemoryFile(value: string | undefined): MemoryFile | undefined {
  const upper = (value ?? '').toUpperCase();
  return upper === 'MEMORY' || upper === 'USER' ? upper : undefined;
}

/** `/usage` 的正文 */
async function usageText(sessionId?: string): Promise<string> {
  const month = await monthlyUsage();
  const budget = await checkBudget();
  const session = sessionId ? await sessionUsage(sessionId) : undefined;

  const lines = [
    '**本月用量**',
    '',
    `- 输入 token：${month.inputTokens}`,
    `- 输出 token：${month.outputTokens}`,
    // 📌 **推理 token 单列** —— 它全额算输出，不拆开就看不出「思考」花了多少
    ...(month.reasoningTokens > 0 ? [`- 其中推理 token：${month.reasoningTokens}`] : []),
    ...(month.cachedTokens > 0 ? [`- 其中命中缓存：${month.cachedTokens}`] : []),
    `- 合计：${month.totalTokens} / 预算 ${budget.budget}（${Math.round(budget.ratio * 100)}%）`,
    `- 费用：$${month.costUsd.toFixed(4)}`,
    `- 调用次数：${month.entries}`,
  ];

  // 📌 **没配单价的模型要说清楚** —— 费用显示 0 不等于「没花钱」
  if (month.unpricedModels.length > 0) {
    lines.push(
      `> ⚠️ 有 ${month.unpricedModels.length} 个模型没配单价` +
        `（${month.unpricedModels.map((name) => `\`${name}\``).join('、')}）—— ` +
        '费用显示 0 是「不知道多少钱」，填 `data/pricing.json` 就有数字了。',
    );
  }

  if (session) {
    lines.push(
      '',
      '**本会话**',
      '',
      `- token：${session.totalTokens}（输入 ${session.inputTokens} / 输出 ${session.outputTokens}）`,
      ...(session.reasoningTokens > 0 ? [`- 其中推理 token：${session.reasoningTokens}`] : []),
      `- 费用：$${session.costUsd.toFixed(4)}`,
      `- 调用次数：${session.entries}`,
    );
    // 📌 **本会话里没配单价的模型也要说清楚**
    if (session.unpricedModels.length > 0) {
      lines.push(
        `> ⚠️ 本会话用到的模型没配单价（${session.unpricedModels
          .map((name) => `\`${name}\``)
          .join('、')}）—— 费用显示 0 是「不知道多少钱」。`,
      );
    }
  }

  if (budget.warn) {
    lines.push('', `> ⚠️ 已超过告警线（${Math.round(config.WARN_RATIO * 100)}%）。`);
  }
  return lines.join('\n');
}

/**
 * 执行一条命令。
 *
 * ⚠️ **执行失败也返回结果** —— 命令出错不该把整轮请求打成 500。
 */
export async function runCommand(
  parsed: ParsedCommand,
  context: CommandContext = {},
): Promise<CommandResult> {
  // ⚠️ **未知命令明确报错** —— 绝不发给模型
  if (!parsed.known) {
    return {
      text: `未知命令 \`/${parsed.name}\` —— \`/help\` 看全部命令。`,
      data: { command: parsed.name, unknown: true },
      action: 'none',
    };
  }

  const sessionId = context.sessionId;

  try {
    switch (parsed.name) {
      case 'help':
        return { text: helpText(), data: { command: 'help' }, action: 'none' };

      case 'new': {
        const session = await createSession();
        return {
          text: '已新建会话 —— 接下来在这里聊。',
          data: { command: 'new', sessionId: session.id },
          action: 'new-session',
        };
      }

      case 'reset': {
        if (!sessionId) return { text: '当前没有会话 —— `/new` 开一个。', action: 'none' };
        // ⚠️ **历史消息与工具流水保留** —— 只是把模型上下文清空：
        //    边界设到最后一条消息，摘要清空 → 下一轮看不到之前的对话
        const last = await Message.findOne({
          where: { session_id: sessionId },
          order: [['created_at', 'DESC']],
        });
        await updateSessionMetadata(sessionId, {
          summary_boundary: last?.id ?? null,
          summary_count: 0,
        });
        const session = await findSession(sessionId);
        if (session) {
          session.summary = null;
          await session.save();
        }
        return {
          text: '已清空本会话的上下文（历史记录与工具流水保留）。',
          data: { command: 'reset' },
          action: 'none',
        };
      }

      case 'model': {
        const primary = resolveModel();
        const fallback = resolveFallback();
        const current = sessionId ? (await getSessionSettings(sessionId)).model : undefined;
        const available = [
          ...(primary ? [primary.name] : []),
          ...(fallback ? [fallback.name] : []),
        ];

        if (!parsed.args) {
          const lines =
            available.length > 0 ? available : ['（还没配置模型 —— 去改 .env 的 LLM_MODEL）'];
          return {
            text: [
              '**可用模型**',
              '',
              ...lines.map((name) => `- ${name}${name === current ? '（本会话正在用）' : ''}`),
              '',
              '`/model <名称>` 切换本会话的模型。',
            ].join('\n'),
            data: { command: 'model', available, current: current ?? null },
            action: 'none',
          };
        }

        if (!available.includes(parsed.args)) {
          return {
            text: `没有这个模型：\`${parsed.args}\` —— 可用的是：${available.join('、') || '（无）'}`,
            data: { command: 'model', available },
            action: 'none',
          };
        }
        if (sessionId) {
          await updateSessionMetadata(sessionId, { session_model: parsed.args });
        }
        return {
          text: `本会话已切到模型 \`${parsed.args}\`。`,
          data: { command: 'model', model: parsed.args },
          action: 'none',
        };
      }

      case 'personality': {
        const available = listPersonalities();
        if (!parsed.args) {
          return {
            text: [
              '**可用人格文件**',
              '',
              ...available.map((name) => `- ${name}`),
              '',
              '`/personality <文件名>` 切换。',
            ].join('\n'),
            data: { command: 'personality', available },
            action: 'none',
          };
        }
        if (!available.includes(parsed.args)) {
          return {
            text: `没有这个人格文件：\`${parsed.args}\` —— 可用的是：${available.join('、')}`,
            data: { command: 'personality', available },
            action: 'none',
          };
        }
        if (sessionId) {
          await updateSessionMetadata(sessionId, { personality: parsed.args });
        }
        return {
          text: `本会话已切到人格 \`${parsed.args}\`。`,
          data: { command: 'personality', personality: parsed.args },
          action: 'none',
        };
      }

      case 'retry': {
        if (!sessionId) return { text: '当前没有会话 —— `/new` 开一个。', action: 'none' };
        const last = await lastAnswerMessageId(sessionId);
        if (!last) return { text: '这一轮还没有回答可以重新生成。', action: 'none' };
        return {
          text: '正在重新生成上一轮回答…',
          data: { command: 'retry', messageId: last },
          action: 'retry',
        };
      }

      case 'undo': {
        if (!sessionId) return { text: '当前没有会话 —— `/new` 开一个。', action: 'none' };
        // ⚠️ **要撤的是「上一轮对话」，不是刚才敲的这条命令** ——
        //    命令本身也是一条用户消息，但它不算一轮
        const lastUser = await lastTurnUserMessage(sessionId);
        if (!lastUser) return { text: '没有可撤销的轮次。', action: 'none' };

        // 📌 **命令自己那条用户消息要留下** ——
        //    它是「撤销」这个动作的记录，删了界面上就只剩一条孤零零的回执
        const newest = await Message.findOne({
          where: { session_id: sessionId, role: 'user' },
          order: [['created_at', 'DESC']],
        });

        // ⚠️ **删掉最后一条用户消息及其之后的全部消息** —— 那一轮整个回退
        await Message.destroy({
          where: {
            session_id: sessionId,
            created_at: { [Op.gte]: lastUser.created_at },
            ...(newest?.id ? { id: { [Op.ne]: newest.id } } : {}),
          },
        });
        // ⚠️ **图状态也要回退** —— 否则下一轮会从旧检查点继续
        await clearThreadState(sessionId);

        return {
          text: '已撤销上一轮。',
          data: { command: 'undo' },
          action: 'undo',
        };
      }

      case 'compress': {
        if (!sessionId) return { text: '当前没有会话 —— `/new` 开一个。', action: 'none' };
        const messages = await loadSessionMessages(sessionId);
        const result = await compressSession(sessionId, messages, { manual: true });
        return {
          text: result.ok
            ? `已压缩上下文：${result.message}。历史消息仍然可以在界面上翻到。`
            : `压缩没成功：${result.message}`,
          data: { command: 'compress', ok: result.ok },
          action: 'none',
        };
      }

      case 'usage': {
        return {
          text: await usageText(sessionId),
          data: { command: 'usage' },
          action: 'none',
        };
      }

      case 'context': {
        // 📌 **零 LLM 调用** —— 这条命令的价值就在于「不花钱也能查」
        const settings = sessionId ? await getSessionSettings(sessionId) : {};
        const report = await buildContextReport({
          ...(sessionId ? { sessionId } : {}),
          ...(parsed.args ? { query: parsed.args } : {}),
          ...(settings.personality ? { personality: settings.personality } : {}),
        });
        return {
          text: renderContextReport(report),
          data: {
            command: 'context',
            query: report.query,
            fixedTokens: report.sections.reduce((sum, item) => sum + item.tokens, 0),
            dynamicTokens: report.dynamic.reduce((sum, item) => sum + item.tokens, 0),
            tools: report.tools.pool,
          },
          action: 'none',
        };
      }

      case 'memory': {
        // 📌 **子命令 + 参数** —— `/memory delete USER prefers-pnpm`
        const parts = parsed.args ? parsed.args.split(/\s+/).filter(Boolean) : [];
        const action = (parts[0] ?? 'list').toLowerCase();
        const file = toMemoryFile(parts[1]);

        if (action === 'list') {
          // 📌 **给了文件就只看那个文件** —— 不给就两个都列
          const wanted = parts[1] ? file : undefined;
          if (parts[1] && !wanted) {
            return {
              text: `记忆文件只有 MEMORY 与 USER 两个 —— 你写的是「${parts[1]}」。\n\n${MEMORY_USAGE}`,
              data: { command: 'memory' },
              action: 'none',
            };
          }
          return {
            text: memoryListText(wanted),
            data: { command: 'memory', action: 'list', file: wanted ?? null },
            action: 'none',
          };
        }

        if (action === 'delete') {
          const name = parts[2];
          if (!file || !name) {
            return {
              text: `用法：\`/memory delete <MEMORY|USER> <名字>\`\n\n${MEMORY_USAGE}`,
              data: { command: 'memory', action: 'delete' },
              action: 'none',
            };
          }
          const result = deleteMemory(file, name);
          return {
            text: result.ok
              ? `${result.message}\n\n${memoryListText()}`
              : `❌ ${result.message}`,
            data: { command: 'memory', action: 'delete', file, name, ok: result.ok },
            action: 'none',
          };
        }

        if (action === 'clear') {
          if (!file) {
            return {
              text: `用法：\`/memory clear <MEMORY|USER>\`\n\n${MEMORY_USAGE}`,
              data: { command: 'memory', action: 'clear' },
              action: 'none',
            };
          }
          const result = clearMemory(file);
          return {
            text: result.ok
              ? `${result.message}\n\n${memoryListText()}`
              : `❌ ${result.message}`,
            data: { command: 'memory', action: 'clear', file, ok: result.ok },
            action: 'none',
          };
        }

        return {
          text: `${MEMORY_USAGE}\n\n${memoryListText()}`,
          data: { command: 'memory', action: 'unknown' },
          action: 'none',
        };
      }

      case 'skills': {
        const skills = listSkills();
        return {
          text:
            skills.length > 0
              ? [
                  '**已安装技能**',
                  '',
                  ...skills.map(
                    (skill) =>
                      `- \`${skill.name}\` —— ${skill.description || '（没写触发条件）'}` +
                      (skill.scripts > 0 ? ` · ${skill.scripts} 个脚本` : ''),
                  ),
                ].join('\n')
              : '还没有安装任何技能（把技能目录拷进 `data/skills/` 即可）。',
          data: { command: 'skills', skills },
          action: 'none',
        };
      }

      case 'cron': {
        const tasks = loadCronTasks();
        const text =
          tasks.length > 0
            ? [
                '**定时任务**',
                '',
                ...tasks.map((task) => `- \`${task.id}\` · ${describeCronTask(task)}`),
                '',
                '在对话里直接说「每天 9 点提醒我……」就能加任务。',
              ].join('\n')
            : '还没有定时任务（对话里说「每天 9 点提醒我……」就能加，或用 `yarn cron:add`）。';
        return {
          text,
          data: { command: 'cron', count: tasks.length },
          action: 'none',
        };
      }

      case 'export': {
        if (!sessionId) return { text: '当前没有会话 —— `/new` 开一个。', action: 'none' };
        const format = parsed.args.toLowerCase() === 'json' ? 'json' : 'md';
        const result = await exportSession(sessionId, format);
        if (!result) return { text: '会话不存在了（可能已被删除）。', action: 'none' };
        const dir = join(paths.data, 'exports');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, result.filename);
        writeFileSync(file, result.content, 'utf8');
        return {
          text: `已导出：${file}`,
          data: { command: 'export', path: file, format },
          action: 'none',
        };
      }

      case 'thinking': {
        const arg = parsed.args.toLowerCase();
        if (arg !== 'on' && arg !== 'off') {
          return {
            text: '用法：`/thinking on` 或 `/thinking off`。',
            data: { command: 'thinking' },
            action: 'none',
          };
        }
        if (sessionId) {
          await updateSessionMetadata(sessionId, { thinking: arg === 'on' });
        }
        return {
          text: `思考模式已${arg === 'on' ? '开启' : '关闭'}（下一轮生效）。`,
          data: { command: 'thinking', thinking: arg === 'on' },
          action: 'none',
        };
      }

      case 'stop': {
        const stopped = sessionId ? stopSessionStream(sessionId) : false;
        return {
          text: stopped ? '已停止当前输出。' : '当前没有在跑的输出。',
          data: { command: 'stop', stopped },
          action: 'stop',
        };
      }

      default:
        return {
          text: `未知命令 \`/${parsed.name}\` —— \`/help\` 看全部命令。`,
          data: { command: parsed.name, unknown: true },
          action: 'none',
        };
    }
  } catch (err) {
    logger.error({ err, command: parsed.name }, '命令执行失败');
    return {
      text: `命令 \`/${parsed.name}\` 执行失败：${err instanceof Error ? err.message : String(err)}`,
      data: { command: parsed.name, failed: true },
      action: 'none',
    };
  }
}

/** 清掉一个会话的图状态（**`/undo` 要回退它**） */
async function clearThreadState(sessionId: string): Promise<void> {
  for (const table of ['graph_checkpoint_writes', 'graph_checkpoints']) {
    try {
      await sequelize.query(`DELETE FROM ${table} WHERE thread_id = :id`, {
        replacements: { id: sessionId },
      });
    } catch (err) {
      // ⚠️ **表不存在就跳过** —— 新机器上迁移还没跑
      logger.warn({ err, table }, '清理检查点失败（表可能还没建）');
    }
  }
}

/**
 * 上一条**真的回答**的消息 id（**跳过命令结果**）。
 *
 * ⚠️ **命令结果也是 assistant 消息** —— 不跳过的话，
 * 第二次 `/retry` 会去「重新生成」上一条命令回执。
 */
async function lastAnswerMessageId(sessionId: string): Promise<string | null> {
  const rows = await Message.findAll({
    where: { session_id: sessionId, role: 'assistant' },
    order: [['created_at', 'DESC']],
    limit: 20,
  });
  for (const row of rows) {
    if (isCommandMessage(row)) continue;
    return row.id;
  }
  return null;
}

/** 这条消息是不是**命令回执**（**正文以 `/` 开头**） */
function isCommandMessage(row: Message): boolean {
  const content = (row.content ?? '').trim();
  if (content.startsWith('/')) return true;
  // 📌 **也看 parts** —— 命令结果带 `data-command` 标记
  if (!row.parts) return false;
  try {
    const parts = JSON.parse(row.parts) as Array<{ type?: string }>;
    return parts.some((part) => part?.type === 'data-command');
  } catch {
    return false;
  }
}

/** 上一轮对话的用户消息（**跳过命令本身**） */
async function lastTurnUserMessage(sessionId: string): Promise<Message | null> {
  const rows = await Message.findAll({
    where: { session_id: sessionId, role: 'user' },
    order: [['created_at', 'DESC']],
    limit: 20,
  });
  for (const row of rows) {
    if ((row.content ?? '').trim().startsWith('/')) continue;
    return row;
  }
  return null;
}

/** 技能目录（**给前端补全用**） */
export function skillNames(): string[] {
  return listSkills().map((skill) => skill.name);
}
