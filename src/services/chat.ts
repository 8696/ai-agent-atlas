import { SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createChatModel, type ResolvedModel } from './model';
import { buildSystemPrompt } from './prompt';
import { toLangChainMessages, type IncomingUiMessage } from './chat-messages';

/**
 * 对话编排 —— **一条「问模型 → 出字」的入口**。
 *
 * 📌 **模型只从 `services/model.ts` 拿**（见 [06](../docs/06-大模型与模型解析.md)）——
 * 别在这里自己 `new ChatAnthropic()`。
 *
 * ⚠️ **本期还没有 LangGraph 图** —— 工具循环 / 人工确认闸 / 检查点都还没接
 * （那是 [12-b B3 ~ B6](../docs/12-b-需求-对话与编排.md)）。
 * 这里先把「模型调用 + 流式出字」这一条竖切打通，
 * 协议翻译在 [`agent/events.ts`](../src/agent/events.ts)，
 * 将来换成图驱动时**只换这一层的内部实现**，前端协议不动。
 */

export type { IncomingUiMessage } from './chat-messages';

/** 一轮对话的事件（**图事件的最小形状** —— 将来图驱动时从这里长出来） */
export type ChatEvent = { type: 'text-delta'; delta: string };

export interface StreamChatOptions {
  /** 前端发来的历史消息 */
  messages: IncomingUiMessage[];
  /** 已解析的模型（由调用方 `resolveModel()` 拿 —— 没配就别进这里） */
  model: ResolvedModel;
  /** 用户勾了「思考模式」 */
  thinking?: boolean;
  /** 客户端断开时 abort —— 上游调用要真的停掉 */
  signal?: AbortSignal;
}

/**
 * 调模型并把增量文本吐成事件。
 *
 * ⚠️ **异常不吞** —— 往上抛，由协议层翻译成 `error` part 推给前端。
 */
export async function* streamChatReply(
  options: StreamChatOptions,
): AsyncGenerator<ChatEvent> {
  const systemPrompt = buildSystemPrompt();
  const history = toLangChainMessages(options.messages);

  const chatModel = createChatModel(options.model, {
    thinking: options.thinking ?? false,
  });

  // ⚠️ **system 在最前** —— 人格与边界规则必须压过历史消息里的任何指令
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...history];

  const stream = await chatModel.stream(messages, {
    ...(options.signal ? { signal: options.signal } : {}),
  });

  for await (const chunk of stream) {
    if (options.signal?.aborted) break;
    // ⚠️ `.text` 只取文本块 —— 思考块 / 工具块不会被当成正文吐给前端
    const delta = chunk.text;
    if (delta) yield { type: 'text-delta', delta };
  }
}
