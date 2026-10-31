import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

/**
 * 消息形状转换 —— **前端 UI Message ↔ LangChain Message**。
 *
 * 📌 **纯函数，不碰配置** —— 能单独跑单元测试（不用先加载 `.env`）。
 *
 * ⚠️ **只取文本** —— 附件 / 工具 part 本期不处理
 * （附件留位，见 [04-b §4.1.2](../docs/04-b-ui-聊天页.md)）。
 */

/** 前端发来的消息（AI SDK UI Message 的最小形状） */
export interface IncomingUiMessage {
  id?: string | undefined;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: string; text?: string | undefined }>;
}

/** 拼出一条消息的纯文本 */
export function extractText(parts: Array<{ type: string; text?: string | undefined }>): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * 取一条消息的纯文本（**内容可能是数组形式** —— 多模态消息的内容是块数组）。
 *
 * ⚠️ **不能直接 `String(content)`** —— 数组会被 stringify 成 `[object Object]`。
 */
export function messageText(message: BaseMessage): string {
  const content: unknown = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}

/** UI Message → LangChain Message（角色一一对应） */
export function toLangChainMessages(messages: IncomingUiMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const message of messages) {
    const text = extractText(message.parts);
    if (message.role === 'system') out.push(new SystemMessage(text));
    else if (message.role === 'assistant') out.push(new AIMessage(text));
    else out.push(new HumanMessage(text));
  }
  return out;
}
