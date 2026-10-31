import { Command, isInterrupted } from '@langchain/langgraph';
import { getGraph } from '../agent/graph.js';
import type { PendingConfirm } from '../agent/state.js';
import type { ToolCard } from '../agent/tool-node.js';
import { toLangChainMessages, type IncomingUiMessage } from './chat-messages.js';
import { waitForDecision, type PendingDecision } from './pending-confirm.js';

/**
 * 对话编排 —— **图驱动的入口**（见 [12-b B3 ~ B6](../docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **模型的回答与工具调用在一次流里完成** —— 不分两次请求，
 * 否则会出现「先回一句『我来查一下』再卡住」的两段式体验。
 *
 * ⚠️ **图逻辑不许知道 SSE 存在** —— 这里只吐领域事件，
 * 协议翻译在 `agent/events.ts`。
 *
 * 📌 **确认闸的循环在这里**：
 * 图挂起（`interrupt`）→ 吐一条 `pending-confirm` 事件 → 等用户的决定 →
 * 用 `Command({ resume })` 恢复图 → 图从检查点继续，**不重跑已执行的工具**。
 */

export type { IncomingUiMessage } from './chat-messages.js';

/** 一轮对话的事件（**图事件的最小形状**） */
export type ChatEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; card: ToolCard }
  | { type: 'pending-confirm'; payload: PendingConfirm }
  | { type: 'notice'; text: string };

export interface ChatTurnOptions {
  /** 前端发来的历史消息（**恢复模式不用传**） */
  messages?: IncomingUiMessage[] | undefined;
  /** 会话 id（**= thread_id**） */
  sessionId?: string | undefined;
  /** 这一轮的 assistant 消息 id（**服务端生成**） */
  messageId: string;
  /** 客户端断开时 abort —— 上游调用要真的停掉 */
  signal?: AbortSignal | undefined;
  /** 恢复模式：用户已经做出的决定 */
  resume?: PendingDecision | undefined;
}

/** 中断时抛的错（**客户端断开时用来跳出等待**） */
function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** 断开时立刻 reject（**别让等待挂到超时**） */
function abortRace(signal: AbortSignal | undefined): Promise<never> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

/**
 * 跑一轮对话（图驱动）。
 *
 * ⚠️ **异常不吞** —— 往上抛，由协议层翻译成 `error` part 推给前端。
 */
export async function* streamChatTurn(options: ChatTurnOptions): AsyncGenerator<ChatEvent> {
  const graph = getGraph();
  const threadId = options.sessionId ?? options.messageId;

  // ⚠️ **外部带进来的决定**（恢复模式：后端重启后由确认端点送进来）——
  //    **只用于第一次挂起**；之后每一次挂起都要重新问用户
  let externalResume = options.resume;
  let input: unknown =
    options.resume !== undefined
      ? new Command({ resume: options.resume })
      : {
          turnMessages: toLangChainMessages(options.messages ?? []),
          sessionId: options.sessionId ?? '',
          messageId: options.messageId,
        };

  for (;;) {
    let interrupted: PendingConfirm | undefined;

    // ⚠️ **`stream()` 返回的是 Promise** —— 要 await 之后才是可迭代的流
    const stream = (await graph.stream(input as never, {
      configurable: { thread_id: threadId },
      streamMode: ['custom', 'values'] as never,
      ...(options.signal ? { signal: options.signal } : {}),
    })) as unknown as AsyncIterable<unknown>;

    for await (const chunk of stream) {
      const [mode, payload] = chunk as [string, unknown];

      if (mode === 'custom') {
        // 📌 **图节点写出来的事件 —— 原样透传**
        yield payload as ChatEvent;
        continue;
      }
      if (mode === 'values' && isInterrupted(payload)) {
        const list = (payload as Record<string, unknown>).__interrupt__ as
          | Array<{ value?: unknown }>
          | undefined;
        const value = list?.[0]?.value as PendingConfirm | undefined;
        if (value) interrupted = value;
      }
    }

    if (!interrupted) break;

    // ⚠️ **先登记等待，再通知前端** ——
    //    反过来的话，用户可能在「等待」登记之前就点了批准，
    //    那一下会找不到人接（确认请求会走「自己恢复」那条路，与原流撞车）
    //
    // ⚠️ **每一次挂起都要登记** —— 一轮里可能有**第二个**危险工具，
    //    那一次也要能等用户点（否则会永远挂着）
    const waiters: Array<Promise<PendingDecision>> = [
      waitForDecision(threadId, interrupted),
    ];
    const aborted = abortRace(options.signal);
    if (aborted) waiters.push(aborted);

    // ── 挂起：告诉前端「要你确认」 ──
    yield { type: 'pending-confirm', payload: interrupted };

    // ⚠️ **等用户的决定** —— 原来的请求不关掉，
    //    批准后同一个流继续往下走（用户看到的是一条消息，不是两条）
    //
    // 📌 **外部带进来的决定只用于第一次**（`options.resume`）——
    //    之后每一次挂起都要重新问用户
    const decision = externalResume ?? (await Promise.race(waiters));
    externalResume = undefined;

    input = new Command({ resume: decision });
  }
}

/**
 * 取这一轮挂在检查点里的 assistant 消息 id。
 *
 * 📌 **重启后恢复时用** —— 续跑的是**同一条消息**，
 * 不会因为重启多出一条（见 [12-b B6](../docs/12-b-需求-对话与编排.md)）。
 */
export async function getPendingTurnMessageId(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const graph = getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: sessionId } });
    const values = snapshot.values as { messageId?: unknown } | undefined;
    const id = values?.messageId;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}
