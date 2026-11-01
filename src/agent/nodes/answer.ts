import type { BaseMessage } from '@langchain/core/messages';
import { getWriter } from '@langchain/langgraph';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { messageText } from '../../services/chat-messages.js';
import { runSkillAutocreate } from '../../skills/autocreate.js';
import type { AtlasStateUpdate } from '../state.js';

/**
 * `answer` 节点 —— **收尾：把这一轮的话定下来**（见 [03-b §B.5.1](../docs/03-b-技术栈-后端栈.md)）。
 *
 * 📌 **正文在 `plan` 节点就已经流给用户了** ——
 * 这里只做两件事：定稿正文、把提示（步数上限之类）单独发一条。
 *
 * ⚠️ **提示走 `data-notice`，不混进正文** ——
 * 混进去的话，落库的正文就跟用户看到的对不上了。
 */

/** 最后一条用户消息（**沉淀技能时要用**） */
function lastUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.getType() === 'human') return messageText(message);
  }
  return '';
}

export function answerNode(
  state: {
    messages: BaseMessage[];
    notice: string | null;
    haltReason: string | null;
    steps: number;
    turnTokens?: number | undefined;
    sessionId?: string | undefined;
    messageId?: string | undefined;
  },
  runnableConfig: { signal?: AbortSignal },
): AtlasStateUpdate {
  let text = '';
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message?.getType() === 'ai') {
      text = messageText(message);
      break;
    }
  }

  // ⚠️ **步数上限也要说清楚** —— 不能默默停下
  const stepLimitHit = (state.steps ?? 0) >= config.MAX_TOOL_STEPS;
  // ⚠️ **单轮 token 上限也要说清楚** —— 用户要知道为什么停了
  const tokenLimitHit =
    config.MAX_TOKENS_PER_TURN > 0 &&
    (state.turnTokens ?? 0) >= config.MAX_TOKENS_PER_TURN;
  const notice =
    state.notice ??
    state.haltReason ??
    (tokenLimitHit
      ? `已达到单轮 token 上限（${config.MAX_TOKENS_PER_TURN}）—— 改 .env 的 MAX_TOKENS_PER_TURN 可以调`
      : stepLimitHit
        ? '已达到步数上限'
        : null);
  if (notice) {
    // ⚠️ **用 `getWriter(config)`** —— 见 `plan.ts` 的注释
    getWriter(runnableConfig)?.({ type: 'notice', text: notice });
  }

  // 📌 **技能自演化** —— 异步问模型「这轮有没有值得沉淀的经验」
  //    ⚠️ **不阻塞本轮回答**（见 [12-c C4.2](../docs/12-c-需求-工具技能与扩展.md)）
  //    ⚠️ **工具调用次数不够就不问** —— 闲聊不该沉淀技能
  const toolCallCount = state.steps ?? 0;
  // ⚠️ **门槛不能跟 `MAX_TOOL_STEPS` 撞车** ——
  //    两个都是 5 的时候，沉淀提问**只会在「工具预算用满」的那一刻**才触发，
  //    平时跑满 4 次工具调用就答完的复杂活反而不沉淀。
  //    现在两个条件都算：**用够了次数** 或 **这轮把预算用满了**（后者一定是复杂活）。
  const effectiveThreshold = Math.min(config.SKILL_MIN_TOOL_CALLS, config.MAX_TOOL_STEPS);
  if (toolCallCount >= effectiveThreshold || stepLimitHit) {
    void runSkillAutocreate({
      userText: lastUserText(state.messages),
      assistantText: text,
      toolCallCount,
      ...(state.messageId ? { turnId: state.messageId } : {}),
    }).catch((err: unknown) => {
      logger.warn({ err }, '技能自演化失败 —— 不影响本轮回答');
    });
  }

  return { finalText: text };
}
