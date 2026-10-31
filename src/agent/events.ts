import type { UIMessageChunk } from 'ai';
import type { ChatEvent } from '../services/chat.js';

export type { ChatEvent };
import { sanitizeMessage } from '../lib/errors.js';

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
 * | 思考增量        | `reasoning-delta`         | 正文上方的思考区   |
 * | 思考开始 / 结束 | `reasoning-start` / `reasoning-end` | —           |
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
/** 第一段思考的 id；思考和正文交错时再往后编号 */
const REASONING_PART_ID = 'reasoning';

export interface ChatEventStreamOptions {
  /** 领域事件流 */
  events: AsyncIterable<ChatEvent>;
  /**
   * assistant 消息的 id（**服务端生成**）。
   *
   * ⚠️ **为什么要后端给 id**：前端要靠它把「这条消息」和「库里那条消息」对上 ——
   * 消息级收藏（📌）点的是消息 id，两边不一致就收藏不到刚生成的那条。
   */
  messageId?: string | undefined;
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
  yield options.messageId ? { type: 'start', messageId: options.messageId } : { type: 'start' };
  yield { type: 'start-step' };

  let textStarted = false;
  let reasoningOpen = false;
  let reasoningCount = 0;
  let reasoningId = REASONING_PART_ID;

  const closeReasoning = function* (): Generator<UIMessageChunk> {
    if (!reasoningOpen) return;
    yield { type: 'reasoning-end', id: reasoningId };
    reasoningOpen = false;
  };

  try {
    for await (const event of options.events) {
      if (event.type === 'reasoning-delta') {
        if (!reasoningOpen) {
          reasoningCount += 1;
          reasoningId =
            reasoningCount === 1 ? REASONING_PART_ID : `${REASONING_PART_ID}-${reasoningCount}`;
          yield { type: 'reasoning-start', id: reasoningId };
          reasoningOpen = true;
        }
        yield { type: 'reasoning-delta', id: reasoningId, delta: event.delta };
        continue;
      }

      yield* closeReasoning();
      if (!textStarted) {
        yield { type: 'text-start', id: TEXT_PART_ID };
        textStarted = true;
      }
      yield { type: 'text-delta', id: TEXT_PART_ID, delta: event.delta };
    }
  } finally {
    yield* closeReasoning();
    if (textStarted) yield { type: 'text-end', id: TEXT_PART_ID };
    yield { type: 'finish-step' };
    yield { type: 'finish' };
  }
}

/** 错误 → 一句人能看懂的话（**不许带密钥**） */
export function describeError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误';
  return sanitizeMessage(raw);
}

/**
 * 落库的 part —— **与推给前端的是同一份**。
 *
 * ⚠️ **同源是硬要求**（见 [12-b B1](../docs/12-b-需求-对话与编排.md)）：
 * 落库的 parts 与推给前端的如果不是同一份，
 * 刷新后卡片内容就会变（用户看到「刷新一下答案不一样」）。
 */
export interface PersistedPart {
  type: 'text' | 'reasoning';
  text: string;
  state: 'done';
  /** 思考块的 id（前端渲染按 id 分块） */
  id?: string;
}

/** part 累加器 —— **吃的是往 SSE 写出去的同一批 chunk** */
export interface PartsAccumulator {
  add: (chunk: UIMessageChunk) => void;
  /** 攒出来的 parts（**顺序 = 出现顺序**） */
  parts: () => PersistedPart[];
  /** 正文纯文本 */
  text: () => string;
}

interface PartSlot {
  kind: 'text' | 'reasoning';
  id: string;
  text: string;
}

/**
 * 建一个 part 累加器。
 *
 * 📌 **用法**：网关里每写一个 chunk 就 `add(chunk)` 一下，
 * 流结束后 `parts()` 拿去落库 —— 落库内容与用户看到的**逐字一致**。
 */
export function createPartsAccumulator(): PartsAccumulator {
  const slots: PartSlot[] = [];

  const ensure = (kind: PartSlot['kind'], id: string): PartSlot => {
    const found = slots.find((slot) => slot.kind === kind && slot.id === id);
    if (found) return found;
    const created: PartSlot = { kind, id, text: '' };
    slots.push(created);
    return created;
  };

  return {
    add(chunk: UIMessageChunk): void {
      if (chunk.type === 'text-start') {
        ensure('text', chunk.id);
      } else if (chunk.type === 'text-delta') {
        ensure('text', chunk.id).text += chunk.delta;
      } else if (chunk.type === 'reasoning-start') {
        ensure('reasoning', chunk.id);
      } else if (chunk.type === 'reasoning-delta') {
        ensure('reasoning', chunk.id).text += chunk.delta;
      }
      // ⚠️ `text-end` / `reasoning-end` 只是收尾 —— 内容已经在 delta 里攒好了
    },
    parts(): PersistedPart[] {
      return slots
        .filter((slot) => slot.text.length > 0)
        .map((slot) =>
          slot.kind === 'reasoning'
            ? { type: 'reasoning', text: slot.text, state: 'done', id: slot.id }
            : { type: 'text', text: slot.text, state: 'done' },
        );
    },
    text(): string {
      return slots
        .filter((slot) => slot.kind === 'text')
        .map((slot) => slot.text)
        .join('');
    },
  };
}
