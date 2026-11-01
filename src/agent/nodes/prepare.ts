import { RemoveMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { logger } from '../../logger.js';
import { messageText } from '../../services/chat-messages.js';
import { buildMemorySection } from '../../services/memory/inject.js';
import { buildRetrievalSection } from '../../services/search.js';
import { prepareSessionContext } from '../../services/session-summary.js';
import { buildSkillSection } from '../../skills/inject.js';
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
 *
 * 📌 **上下文三件套也在这一步算好**（**每轮只算一次**）：
 * - **摘要** —— 边界之前的历史折成一段，原文不再进上下文
 * - **记忆** —— 召回的长期记忆，带用量表头
 * - **检索** —— 跨会话检索的摘要（要调一次模型，放节点里就不会重复调）
 */

/** 最后一条用户消息（**拿它做相关度排序的查询**） */
function lastUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.getType() === 'human') return messageText(message);
  }
  return '';
}

export async function prepareNode(state: {
  turnMessages: BaseMessage[];
  sessionId?: string | undefined;
  isolated?: boolean | undefined;
}): Promise<AtlasStateUpdate> {
  // ── 摘要与裁剪 ──
  let messages = state.turnMessages;
  let summary = '';
  // ⚠️ **子代理不看主对话的历史** —— 只给它「任务」这一条
  //    （见 [12-b B10](../docs/12-b-需求-对话与编排.md)）
  if (state.sessionId && !state.isolated) {
    try {
      const context = await prepareSessionContext(state.sessionId, state.turnMessages);
      messages = context.messages;
      summary = context.summary;
    } catch (err) {
      // ⚠️ **压缩失败不影响对话** —— 按原样送进去
      logger.warn({ err, sessionId: state.sessionId }, '准备会话上下文失败 —— 按原样继续');
    }
  }

  const query = lastUserText(messages);

  // ── 记忆召回（**同步、零成本**） ──
  let memories = '';
  try {
    memories = buildMemorySection(query);
  } catch (err) {
    logger.warn({ err }, '召回记忆失败 —— 跳过这一段');
  }

  // ── 跨会话检索（**要调一次模型** —— 没命中就不调） ──
  let retrieval = '';
  // ⚠️ **子代理不查跨会话检索** ——
  //    检索查的是 `messages` 表（**含主会话的消息**），
  //    命中后还会折成摘要塞进子代理的上下文 ——
  //    那等于把主对话的历史又喂给了子代理，「隔离上下文」就漏了
  //    （见 [12-b B10](../docs/12-b-需求-对话与编排.md)）
  if (!state.isolated) {
    try {
      retrieval = await buildRetrievalSection(query);
    } catch (err) {
      logger.warn({ err }, '跨会话检索失败 —— 跳过这一段');
    }
  }

  // ── 技能匹配（**走 FTS5** —— 命中的技能正文进上下文） ──
  let skills = '';
  try {
    skills = await buildSkillSection(query);
  } catch (err) {
    logger.warn({ err }, '技能匹配失败 —— 跳过这一段');
  }

  return {
    messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...messages],
    executedToolCalls: [],
    lastToolName: null,
    lastToolCount: 0,
    rejectedToolCalls: [],
    steps: 0,
    // 📌 **本轮 token 清零** —— 单轮上限按「这一轮」算
    turnTokens: 0,
    haltReason: null,
    notice: null,
    summary,
    memories,
    retrieval,
    skills,
  };
}
