import type { UIMessageChunk } from 'ai';
import type { ChatEvent } from '../services/chat';
import { sanitizeMessage } from '../lib/errors';

/**
 * **协议翻译层** —— 领域事件 → AI SDK UI Message Stream 的 part 序列。
 *
 * 📌 **图逻辑不许知道 SSE 存在**（见 [03-b §B.5.2](../docs/03-b-技术栈-后端栈.md)）——
 * 换前端框架时只改这一层。
 *
 * 映射表（[03-b §B.6.2](../docs/03-b-技术栈-后端栈.md)）：
 *
 * | 领域事件        | SSE part                  | 前端表现           |
 * | --------------- | ------------------------- | ------------------ |
 * | 文本增量        | `text-delta`              | 气泡里逐字出现     |
 * | 文本开始 / 结束 | `text-start` / `text-end`  | —                  |
 * | 图结束          | `finish`                  | 结束 loading 状态  |
 * | 出错            | `error`                   | 显示错误原因       |
 *
 * ⚠️ **这里产出的是「chunk 对象」**，SSE 的封装（`data: ...\n\n`）在网关层做 ——
 * 协议与传输分开，换传输方式时不用动这里。
 */

/** 文本块的 id —— 一个 assistant 消息里只有一段正文，用固定 id 即可 */
const TEXT_PART_ID = '0';

export interface ChatEventStreamOptions {
  /** 领域事件流 */
  events: AsyncIterable<ChatEvent>;
}

/**
 * 把领域事件流翻译成 UI Message Stream 的 chunk 序列。
 *
 * ⚠️ **异常不吞** —— 往上抛，网关层翻译成 `error` chunk 推给前端，
 * 用户看到的是「出错了 + 原因」，而不是白屏。
 */
export async function* createChatEventStream(
  options: ChatEventStreamOptions,
): AsyncGenerator<UIMessageChunk> {
  yield { type: 'start' };
  yield { type: 'start-step' };

  let textStarted = false;
  try {
    for await (const event of options.events) {
      if (!textStarted) {
        yield { type: 'text-start', id: TEXT_PART_ID };
        textStarted = true;
      }
      yield { type: 'text-delta', id: TEXT_PART_ID, delta: event.delta };
    }
  } finally {
    if (textStarted) yield { type: 'text-end', id: TEXT_PART_ID };
    yield { type: 'finish-step' };
    yield { type: 'finish' };
  }
}

/** 错误 → 一句人能看懂的话（**不许带密钥**） */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误';
  return sanitizeMessage(raw);
}
