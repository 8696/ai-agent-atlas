import { Op } from 'sequelize';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sequelize } from '../db.js';
import { Message } from '../models/message.model.js';
import { checkBudget, monthlyUsage, sessionUsage } from './cost.js';
import { stopSessionStream } from './chat.js';
import { resolveFallback, resolveModel } from './model.js';
import { listPersonalities } from './prompt.js';
import { getSkills } from '../skills/store.js';
import { compressSession, loadSessionMessages } from './session-summary.js';
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
  { name: 'skills', usage: '/skills', summary: '列出已安装技能' },
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
    `- 合计：${month.totalTokens} / 预算 ${budget.budget}（${Math.round(budget.ratio * 100)}%）`,
    `- 费用：$${month.costUsd.toFixed(4)}${month.costUsd === 0 ? '（单价没配，见 `data/pricing.json`）' : ''}`,
    `- 调用次数：${month.entries}`,
  ];

  if (session) {
    lines.push(
      '',
      '**本会话**',
      '',
      `- token：${session.totalTokens}（输入 ${session.inputTokens} / 输出 ${session.outputTokens}）`,
      `- 费用：$${session.costUsd.toFixed(4)}`,
      `- 调用次数：${session.entries}`,
    );
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

        // ⚠️ **删掉最后一条用户消息及其之后的全部消息** —— 那一轮整个回退
        await Message.destroy({
          where: { session_id: sessionId, created_at: { [Op.gte]: lastUser.created_at } },
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
