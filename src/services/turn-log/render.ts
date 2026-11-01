import type { SessionTurnLog, TurnLogEventView, TurnLogTurnView } from './types.js';

/**
 * 会话全链路日志 —— **渲染成给人看的 Markdown**
 * （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **斜杠命令 `/log` 用它** —— 摘要要短（**聊天气泡里刷屏不好**），
 *    完整原文在网页版 `/sessions/:id/log`。
 */

/** 字符串长度（**非字符串当 0**） */
function sizeOf(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

/** 从 payload 里取一个字段（**类型安全**） */
function field(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== 'object') return undefined;
  return (payload as Record<string, unknown>)[key];
}

/** 取一个字符串（**别的类型一律当空串**） */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 取一个数字（**别的类型一律当 0**） */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 事件的摘要（**一行**） */
function summarize(event: TurnLogEventView): string {
  const payload = event.payload;
  switch (event.type) {
    case 'request.received':
      return `用户输入 ${sizeOf(field(payload, 'userText'))} 字 · 历史 ${(field(payload, 'messages') as unknown[] | undefined)?.length ?? 0} 条`;
    case 'command.executed':
      return `/${text(field(payload, 'command'))} ${text(field(payload, 'args'))}`.trim();
    case 'context.prepared':
      return [
        `摘要 ${sizeOf(field(payload, 'summary'))} 字`,
        `记忆 ${sizeOf(field(payload, 'memories'))} 字`,
        `检索 ${sizeOf(field(payload, 'retrieval'))} 字`,
        `技能 ${sizeOf(field(payload, 'skills'))} 字`,
      ].join(' · ');
    case 'llm.request':
      return [
        `模型 ${text(field(payload, 'model'))}`,
        `${(field(payload, 'tools') as unknown[] | undefined)?.length ?? 0} 个工具`,
        `系统提示词 ${sizeOf(field(payload, 'systemPrompt'))} 字`,
        `${(field(payload, 'messages') as unknown[] | undefined)?.length ?? 0} 条消息`,
      ].join(' · ');
    case 'llm.response': {
      const usage = field(payload, 'usage') as Record<string, unknown> | undefined;
      return [
        `正文 ${sizeOf(field(payload, 'text'))} 字`,
        `思考 ${sizeOf(field(payload, 'reasoning'))} 字`,
        `${(field(payload, 'toolCalls') as unknown[] | undefined)?.length ?? 0} 个工具调用`,
        usage ? `${num(usage.totalTokens)} token` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'llm.utility':
      return `用途 ${text(field(payload, 'purpose'))} · 模型 ${text(field(payload, 'model'))}`;
    case 'model.fallback':
      return `${text(field(payload, 'from'))} → ${text(field(payload, 'to'))}`;
    case 'tool.decision':
      return [
        `工具 ${text(field(payload, 'tool'))}`,
        `判定 ${text(field(payload, 'decision'))}`,
        `敏感档 ${text(field(payload, 'effectiveSensitivity') || field(payload, 'sensitivity'))}`,
      ].join(' · ');
    case 'confirm.request':
      return `工具 ${text(field(payload, 'tool'))}`;
    case 'confirm.decision':
      return `工具 ${text(field(payload, 'tool'))} · ${
        field(payload, 'approved') === true ? '已批准' : '已拒绝'
      }`;
    case 'tool.execute':
      return [
        `工具 ${text(field(payload, 'tool'))}`,
        text(field(payload, 'status')),
        `${num(field(payload, 'durationMs'))} ms`,
        `输出 ${sizeOf(field(payload, 'output'))} 字`,
      ].join(' · ');
    case 'memory.extracted':
      return `应用 ${num(field(payload, 'applied'))} 条 · 拒绝 ${num(field(payload, 'rejected'))} 条`;
    case 'skill.autocreated':
      return `技能 ${text(field(payload, 'name'))}`;
    case 'turn.finished':
      return [
        `正文 ${sizeOf(field(payload, 'text'))} 字`,
        `${num(field(payload, 'steps'))} 步`,
        `${num(field(payload, 'turnTokens'))} token`,
      ].join(' · ');
    case 'turn.error':
      return text(field(payload, 'error')) || '出错';
    default:
      return event.title;
  }
}

/**
 * 时间显示（**本地时区** —— 跟网页上看到的一致）。
 *
 * 📌 **存的是 UTC 墙钟字符串，读出来是 ISO** —— 这里统一转成本地时间，
 *    别让「网页 14:37、命令里 06:37」这种事发生。
 */
function shortTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace('T', ' ').slice(0, 19);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 轮次的状态标签 */
function statusLabel(status: string): string {
  if (status === 'finished') return '已完成';
  if (status === 'failed') return '已中断';
  if (status === 'unknown') return '状态未知';
  return '进行中';
}

/**
 * 渲染一份会话日志（**Markdown**）。
 *
 * 📌 **每轮一节 · 每个事件一行** —— 摘要够看，原文去网页版看。
 */
export function renderSessionLog(log: SessionTurnLog): string {
  const events = log.turns.reduce((sum, turn) => sum + turn.events.length, 0);
  const lines: string[] = ['**会话日志**', '', `共 ${log.turns.length} 轮 · ${events} 个事件`, ''];

  if (log.turns.length === 0) {
    lines.push('（这个会话还没有日志记录）');
    return lines.join('\n');
  }

  log.turns.forEach((turn: TurnLogTurnView, index: number) => {
    lines.push(
      `### 第 ${index + 1} 轮 · ${shortTime(turn.startedAt)} · ${
        turn.model ? `模型 ${turn.model}` : '模型未知'
      } · ${statusLabel(turn.status)}`,
      '',
    );
    if (turn.events.length === 0) {
      lines.push('- （这一轮没有事件）', '');
      return;
    }
    for (const event of turn.events) {
      lines.push(`- **${event.label}** —— ${summarize(event)}`);
    }
    lines.push('');
  });

  lines.push(
    '> 📌 **这里只有摘要** —— 完整的模型请求体、工具出参、上下文原文在网页版：',
    `> \`/sessions/${log.sessionId}/log\``,
  );
  return lines.join('\n');
}
