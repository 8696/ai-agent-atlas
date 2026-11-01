import { listMessages, type MessageView, type UiPart } from './message.js';
import { findSession } from './session.js';
import { DEFAULT_TITLE } from '../lib/session-title.js';

/**
 * 会话导出 —— **把一段对话变成能带走的文件**
 * （见 [12-b B2](./docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **数据是本地唯一资产** —— 现在只能**在界面上看**，
 *    想留一份、想贴给别人、想进版本库，都没有出口。
 *
 * 📌 **两种格式**：
 * - `md` —— 人读的（对话 + 工具卡片）
 * - `json` —— 机器读的（完整的消息与 parts）
 */

/** 导出格式 */
export type ExportFormat = 'md' | 'json';

/** 导出结果 */
export interface ExportResult {
  /** 建议的文件名 */
  filename: string;
  /** 正文 */
  content: string;
  /** MIME 类型 */
  mimeType: string;
}

/** 角色 → 标题 */
function roleTitle(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'system') return '系统';
  return role;
}

/** 时间戳（**去掉毫秒** —— 导出给人看的，不要那么精确） */
function formatTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 文件名里不能有的字符 */
function safeName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\n\r\t]/g, ' ').trim();
  return (cleaned === '' ? 'session' : cleaned).slice(0, 40);
}

/** 工具卡片的数据（**从 part 的 data 里取**） */
interface ToolCardData {
  toolName?: string;
  status?: string;
  input?: unknown;
  output?: string;
  error?: string;
  durationMs?: number;
}

/** 一个 part 是不是工具卡片 */
function toolCardOf(part: UiPart): ToolCardData | undefined {
  if (part.type !== 'data-tool-call') return undefined;
  const data = part.data as ToolCardData | undefined;
  return data && typeof data === 'object' ? data : undefined;
}

/** 渲染成 Markdown */
function toMarkdown(sessionId: string, session: Awaited<ReturnType<typeof findSession>>, messages: MessageView[]): string {
  const title = session?.title || DEFAULT_TITLE;
  const lines: string[] = [`# ${title}`, ''];

  lines.push(`- 会话 id：\`${sessionId}\``);
  if (session?.favorite === 1) lines.push('- ★ 已收藏');
  lines.push(`- 创建：${formatTime(session?.created_at ?? null)}`);
  lines.push(`- 最后活动：${formatTime(session?.last_active_at ?? null)}`);
  lines.push(`- 消息数：${messages.length}`);
  lines.push('', '---', '');

  for (const message of messages) {
    lines.push(`## ${roleTitle(message.role)} · ${formatTime(message.createdAt)}`);
    lines.push('');

    if (message.content) {
      lines.push(message.content);
      lines.push('');
    }

    // 📌 **工具卡片也进导出** —— 「当时到底调了什么」是最值得留下的部分
    for (const part of message.parts) {
      const card = toolCardOf(part);
      if (!card) continue;
      const status = card.status ? ` · ${card.status}` : '';
      const cost = card.durationMs !== undefined ? ` · ${card.durationMs}ms` : '';
      lines.push(`### 🔧 ${card.toolName ?? '工具'}${status}${cost}`);
      lines.push('');
      if (card.input !== undefined) {
        lines.push('入参：');
        lines.push('');
        lines.push('```json');
        lines.push(safeJson(card.input));
        lines.push('```');
        lines.push('');
      }
      if (card.output) {
        lines.push('出参：');
        lines.push('');
        lines.push('```');
        lines.push(card.output);
        lines.push('```');
        lines.push('');
      }
      if (card.error) {
        lines.push(`> ⚠️ ${card.error}`);
        lines.push('');
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** JSON 序列化（**出错也不炸**） */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '"[无法序列化]"';
  }
}

/**
 * 导出一个会话。
 *
 * @param sessionId 会话 id
 * @param format `md`（人读）或 `json`（机器读）
 * @returns 会话不存在时返回 `null`
 */
export async function exportSession(
  sessionId: string,
  format: ExportFormat = 'md',
): Promise<ExportResult | null> {
  const session = await findSession(sessionId);
  if (!session) return null;

  const messages = await listMessages(sessionId);
  const title = session.title || DEFAULT_TITLE;
  const stem = `${safeName(title)}-${sessionId.slice(0, 8)}`;

  if (format === 'json') {
    return {
      filename: `${stem}.json`,
      content: `${safeJson({
        session: {
          id: session.id,
          title,
          status: session.status,
          favorite: session.favorite === 1,
          messageCount: session.message_count,
          createdAt: session.created_at,
          lastActiveAt: session.last_active_at,
        },
        messages,
      })}\n`,
      mimeType: 'application/json; charset=utf-8',
    };
  }

  return {
    filename: `${stem}.md`,
    content: toMarkdown(sessionId, session, messages),
    mimeType: 'text/markdown; charset=utf-8',
  };
}
