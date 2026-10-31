import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { logger } from '../../logger.js';
import { createChatModel, resolveModel } from '../model.js';
import { isValidCron } from './schedule.js';

/**
 * 自然语言 → cron 表达式（见 [12-b B11](./docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **解析一次，存下来** —— 不每次重解析（每次都调模型 = 每次都花钱）。
 * ⚠️ **解析不出来就报错** —— 保留原文，不静默丢弃。
 */

/** 给模型的提示词 */
const PARSE_PROMPT = `你把「周期描述」翻译成 5 段 cron 表达式（分 时 日 月 周）。

规则：
- 只输出表达式本身，不要解释，不要加代码块，不要加任何别的话
- 每天 → "分 时 * * *"
- 每小时 → "分 * * * *"
- 每周一 → "分 时 * * 1"（0=周日，1=周一，…，6=周六）
- 每月 1 号 → "分 时 1 * *"
- 「工作日」→ "分 时 * * 1-5"
- 「每隔 N 分钟」→ "*/N * * * *"
- 时区按 Asia/Shanghai
- 分与小时用 0-59 / 0-23；日 1-31；月 1-12

描述：`;

export class CronParseError extends Error {
  readonly code: string;

  constructor(message: string, code = 'CRON_PARSE_FAILED') {
    super(message);
    this.name = 'CronParseError';
    this.code = code;
  }
}

/**
 * 把自然语言描述解析成 cron 表达式。
 *
 * @throws 解析不出合法表达式时抛 `CronParseError`
 */
export async function parseScheduleToCron(schedule: string): Promise<string> {
  const text = schedule.trim();
  if (text === '') {
    throw new CronParseError('周期描述是空的', 'CRON_SCHEDULE_EMPTY');
  }

  // 📌 **已经是合法表达式就直接用** —— 不用每次都过模型
  if (isValidCron(text)) return text;

  const model = resolveModel();
  if (!model) {
    throw new CronParseError(
      '还没配置模型 —— 没法把周期描述翻译成 cron 表达式（也可以直接写 5 段表达式）',
      'CRON_NO_MODEL',
    );
  }

  const chat = await createChatModel(model);
  let reply: string;
  try {
    const response = await chat.invoke([
      new SystemMessage(PARSE_PROMPT),
      new HumanMessage(text),
    ]);
    reply = extractText(response);
  } catch (err) {
    throw new CronParseError(
      `解析周期描述失败：${err instanceof Error ? err.message : String(err)}`,
      'CRON_MODEL_ERROR',
    );
  }

  const expression = cleanExpression(reply);
  if (!isValidCron(expression)) {
    logger.warn({ schedule: text, reply }, '模型给的 cron 表达式不合法');
    throw new CronParseError(
      `解析不出合法的 cron 表达式（模型给的是「${expression || '空'}」）—— 原文保留在任务里`,
      'CRON_INVALID_EXPRESSION',
    );
  }
  return expression;
}

/** 从模型回复里抠出表达式（**去掉代码块与解释**） */
export function cleanExpression(reply: string): string {
  let text = reply.trim();
  // ⚠️ **模型爱加代码块** —— 去掉
  const fence = text.match(/```(?:cron|text)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  // ⚠️ **只取第一行** —— 后面的多半是解释
  const line = text.split('\n').map((item) => item.trim()).find((item) => item !== '') ?? '';
  return line.replace(/^["'`]|["'`]$/g, '').trim();
}

/** 从模型回复里取纯文本 */
function extractText(response: unknown): string {
  if (typeof response === 'string') return response;
  const content = (response as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}
