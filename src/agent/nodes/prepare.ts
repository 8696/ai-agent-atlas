import { RemoveMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { logger } from '../../logger.js';
import { messageText } from '../../services/chat-messages.js';
import { buildMemorySection } from '../../services/memory/inject.js';
import { buildRetrievalSection } from '../../services/search.js';
import { prepareSessionContext } from '../../services/session-summary.js';
import { buildSkillSection } from '../../skills/inject.js';
import { logEvent, turnIdOf } from '../../services/turn-log/emit.js';
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
  messageId?: string | undefined;
  logTurnId?: string | undefined;
  isolated?: boolean | undefined;
}): Promise<AtlasStateUpdate> {
  // 📌 **埋点上下文** —— 「这一轮是哪个」（辅助模型调用要知道往哪记）
  const trace = state.sessionId
    ? { turnId: turnIdOf(state), sessionId: state.sessionId }
    : undefined;

  // ── 摘要与裁剪 ──
  let messages = state.turnMessages;
  let summary = '';
  // ⚠️ **子代理不看主对话的历史** —— 只给它「任务」这一条
  //    （见 [12-b B10](../docs/12-b-需求-对话与编排.md)）
  if (state.sessionId && !state.isolated) {
    try {
      const context = await prepareSessionContext(state.sessionId, state.turnMessages, {
        ...(trace ? { trace } : {}),
      });
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
      retrieval = await buildRetrievalSection(query, trace ?? undefined);
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

  // 📌 **上下文装配记进会话日志**（**四段各是什么、原文多少**）
  //    —— 这是「它怎么知道这件事」的唯一线索
  //    （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）
  const turnId = turnIdOf(state);
  if (state.sessionId && turnId) {
    logEvent({
      turnId,
      sessionId: state.sessionId,
      type: 'context.prepared',
      eventKey: 'context.prepared',
      title: '上下文装配',
      payload: {
        summary,
        memories,
        retrieval,
        skills,
        messageCount: messages.length,
        historyChars: messages.reduce((sum, message) => sum + messageText(message).length, 0),
      },
    });
  }

  return {
    messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...messages],
    // 📌 **用完就清掉本轮输入** ——
    //    `turnMessages` 是「网关传进来的前端历史」，
    //    它的唯一用途就是给 `prepare` 当输入（见 `agent/state.ts`）。
    //    ⚠️ **不清掉的话它会被存进每一个检查点** ——
    //    检查点本来就含全量消息，再叠一份完整历史，
    //    存储直接翻倍（改之前 36 条消息的库里有 3.46 MB 检查点）。
    //    📌 **清空是安全的** —— 下一轮的 `turnMessages` 由网关重新传进来，
    //    恢复时也不需要它（`prepare` 已经跑过了）。
    turnMessages: [],
    executedToolCalls: [],
    lastToolName: null,
    lastToolCount: 0,
    rejectedToolCalls: [],
    steps: 0,
    // 📌 **本轮 token 清零** —— 单轮上限按「这一轮」算
    turnTokens: 0,
    // 📌 **「本轮剩下的都批准」清零** —— 它只在这一轮有效
    approveAllRemaining: false,
    haltReason: null,
    notice: null,
    summary,
    memories,
    retrieval,
    skills,
  };
}
