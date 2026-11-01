import { Command, isInterrupted } from '@langchain/langgraph';
import { getGraph } from '../agent/graph.js';
import type { PendingConfirm } from '../agent/state.js';
import type { ToolCard } from '../agent/tool-node.js';
import { toLangChainMessages, type IncomingUiMessage } from './chat-messages.js';
import { clearPending, waitForDecision, type PendingDecision } from './pending-confirm.js';

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

/**
 * 正在跑的会话流（**`/stop` 要用它**）。
 *
 * 📌 **按会话 id 登记** —— 一个会话同一时刻只有一条流。
 */
const activeStreams = new Map<string, AbortController>();

/** 登记一条在跑的流 */
export function registerSessionStream(sessionId: string, controller: AbortController): void {
  activeStreams.set(sessionId, controller);
}

/** 注销一条流（**结束时要清掉** —— 不然 map 会越攒越多） */
export function unregisterSessionStream(sessionId: string): void {
  activeStreams.delete(sessionId);
}

/**
 * 停掉某个会话正在跑的流（**`/stop` 用**）。
 *
 * @returns 有没有真的停掉
 */
export function stopSessionStream(sessionId: string): boolean {
  const controller = activeStreams.get(sessionId);
  if (!controller) return false;
  controller.abort();
  activeStreams.delete(sessionId);
  return true;
}

/** 一轮对话的事件（**图事件的最小形状**） */
export type ChatEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; card: ToolCard }
  | { type: 'pending-confirm'; payload: PendingConfirm }
  | { type: 'notice'; text: string }
  | { type: 'command'; payload: CommandEventPayload };

/**
 * 斜杠命令的结果（**不经过图** —— 直接在网关里产生）。
 *
 * 📌 **零 LLM 调用** —— 命令是用户敲的，不是模型说的。
 */
export interface CommandEventPayload {
  /** 命令名（**不含斜杠**） */
  command: string;
  /** 前端接下来要做什么 */
  action?: string;
  /** 机器可读载荷 */
  data?: unknown;
}

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

  // ⚠️ **恢复模式**（后端重启后由确认端点送进来）
  //
  // 📌 **一次恢复只解决一个挂起** ——
  //    `options.resume` 由下面的 `Command` 带给图，**不能再留一份**给下一个挂起。
  //    留着的话：用户批准了危险工具 A，同一轮里的危险工具 B 会**直接拿到 A 的批准**，
  //    用户从没就 B 作答过（见 [12-b B5](../docs/12-b-需求-对话与编排.md)）。
  const resuming = options.resume !== undefined;
  let input: unknown = resuming
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
          Array<{ value?: unknown }> | undefined;
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
    const waiters: Array<Promise<PendingDecision>> = [];
    // 📌 **恢复模式不登记** —— 那一轮只解决这一个挂起，
    //    下一个批准要走新的 HTTP 请求（登记了也没人接）
    if (!resuming) waiters.push(waitForDecision(threadId, interrupted));
    const aborted = abortRace(options.signal);
    if (aborted) waiters.push(aborted);

    // ── 挂起：告诉前端「要你确认」 ──
    yield { type: 'pending-confirm', payload: interrupted };

    // ⚠️ **恢复模式：这一轮只解决这一个挂起** ——
    //    后面还有挂起就**结束这一轮**，把卡片交给前端再问一次
    //    （批准要走另一个 HTTP 请求 —— 在这儿死等会把那个请求挂住）。
    //    📌 **绝不沿用上一个批准** —— 用户批准的是工具 A，工具 B 从没被问过。
    if (resuming) break;

    // ⚠️ **等用户的决定** —— 原来的请求不关掉，
    //    批准后同一个流继续往下走（用户看到的是一条消息，不是两条）
    let decision: PendingDecision;
    try {
      decision = await Promise.race(waiters);
    } catch (err) {
      // ⚠️ **流断了就把登记撤掉** —— 不撤的话，
      //    用户之后点批准会走「有人在等」那条路，而那条流已经死了，
      //    批准就**被吞掉**（工具永远不执行，用户还以为批了）
      clearPending(threadId);
      throw err;
    }

    input = new Command({ resume: decision });
  }
}

/**
 * 取这一轮挂在检查点里的 assistant 消息 id。
 *
 * 📌 **重启后恢复时用** —— 续跑的是**同一条消息**，
 * 不会因为重启多出一条（见 [12-b B6](../docs/12-b-需求-对话与编排.md)）。
 */
export async function getPendingTurnMessageId(sessionId: string): Promise<string | undefined> {
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
