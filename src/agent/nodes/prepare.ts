import { RemoveMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type { AtlasStateUpdate } from '../state.js';

/**
 * `prepare` 节点 —— **每轮开头把状态对齐到前端的历史**。
 *
 * ⚠️ **为什么要有这一步**：
 * 前端的历史才是真相（会话层是「客户端是真相」的对账模型，见 [12-b B2](../docs/12-b-需求-对话与编排.md)）。
 * 「重新生成」会把上一条回答砍掉 —— 图状态里也得跟着砍，
 * 否则模型会看到一条已经不存在的回答。
 *
 * 📌 **`RemoveMessage(REMOVE_ALL_MESSAGES)` 是「清空再写」** ——
 * `messagesStateReducer` 认这个哨兵：它之前的全丢，它之后的留下。
 */
export function prepareNode(state: {
  turnMessages: BaseMessage[];
}): AtlasStateUpdate {
  return {
    messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...state.turnMessages],
    executedToolCalls: [],
    lastToolName: null,
    lastToolCount: 0,
    rejectedToolCalls: [],
    steps: 0,
    haltReason: null,
    notice: null,
  };
}
