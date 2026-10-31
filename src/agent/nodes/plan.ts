import { nanoid } from 'nanoid';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { getWriter } from '@langchain/langgraph';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { scanInjection, tightenSensitivity } from '../../lib/security/injection.js';
import { estimateTokens } from '../../lib/tokens.js';
import { writeAudit } from '../../lib/audit.js';
import { buildSystemPrompt, readAgentsInstructions } from '../../services/prompt.js';
import {
  resolveFallback,
  resolveModel,
  type ResolvedModel,
} from '../../services/model.js';
import { streamChatModel, readReasoningDelta } from '../model-stream.js';
import { recordUsage } from '../../services/cost.js';
import { getSessionSettings } from '../../services/session.js';
import { requestSignal } from '../abort.js';
import { getToolRegistry, toLangChainTools } from '../../tools/registry.js';
import { selectTools } from '../../tools/selection.js';
import { assembleToolCalls } from '../tool-calls.js';
import { messageText } from '../../services/chat-messages.js';
import type { AtlasStateUpdate } from '../state.js';

/**
 * `plan` 节点 —— **调模型：直接答，还是调工具？**
 * （见 [12-b B3](../docs/12-b-需求-对话与编排.md) 与 [03-b §B.5.1](../docs/03-b-技术栈-后端栈.md)）。
 *
 * ⚠️ **判定交给模型** —— 不做关键词规则匹配。
 * ⚠️ **回答与工具调用在一次流里完成** —— 否则会出现
 * 「先回一句『我来查一下』再卡住」的两段式体验。
 *
 * 📌 **工具池按相关度裁剪** —— 裁剪发生在调模型之前，
 * 被裁掉的工具这一轮模型完全看不到。
 */

/** 从一块模型增量里取出思考文本（**Anthropic 把思考放在独立块里**） */
export { readReasoningDelta };

/** 最后一条用户消息（**拿它做工具裁剪的查询**） */
function lastUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.getType() === 'human') return messageText(message);
  }
  return '';
}

/** 工具清单（**给系统提示词看的**） */
function describeTools(names: string[]): string {
  if (names.length === 0) return '（本期没有可用工具）';
  return names.join('、');
}

/**
 * 会话级模型覆盖（**`/model <名称>` 切的**）。
 *
 * ⚠️ **只认主模型与备用模型** —— 认不出来就用主模型，
 * 不接受任意模型标识（那是配置问题，不是命令能解决的）。
 */
function pickSessionModel(primary: ResolvedModel, name: string | undefined): ResolvedModel {
  if (!name) return primary;
  const fallback = resolveFallback();
  if (fallback && fallback.name === name) return fallback;
  if (primary.name === name) return primary;
  logger.warn({ name }, '会话指定的模型认不出来 —— 仍用主模型');
  return primary;
}

/**
 * 计划节点。
 *
 * @param state 图状态
 * @param runnableConfig LangGraph 传进来的配置（**信号、writer 都在里面**）
 */
export async function planNode(
  state: {
    messages: BaseMessage[];
    summary?: string | undefined;
    memories?: string | undefined;
    retrieval?: string | undefined;
    skills?: string | undefined;
    sessionId?: string | undefined;
    messageId?: string | undefined;
    isolated?: boolean | undefined;
    model?: string | undefined;
  },
  runnableConfig: { signal?: AbortSignal },
): Promise<AtlasStateUpdate> {
  const primary = resolveModel();
  if (!primary) {
    throw new Error('还没配置模型 —— 去改 .env 的 LLM_MODEL');
  }

  // ── 会话级设置（**模型 / 思考开关 / 人格**） ──
  let sessionModel = primary;
  let thinkingBudget = primary.thinkingBudget;
  let personality: string | undefined;
  if (state.sessionId) {
    try {
      const settings = await getSessionSettings(state.sessionId);
      sessionModel = pickSessionModel(primary, settings.model);
      if (settings.thinking === false) thinkingBudget = 0;
      else if (settings.thinking === true) thinkingBudget = sessionModel.thinkingBudget;
      personality = settings.personality;
    } catch (err) {
      logger.warn({ err, sessionId: state.sessionId }, '读会话设置失败 —— 用全局配置');
    }
  }
  // 📌 **子代理指定的模型优先** —— 只认主模型与备用模型（认不出来就用主模型）
  if (state.model) {
    sessionModel = pickSessionModel(primary, state.model);
    thinkingBudget = sessionModel.thinkingBudget;
  }
  const model: ResolvedModel = { ...sessionModel, thinkingBudget };

  // ── 工具池裁剪 ──
  const registry = getToolRegistry();
  const enabled = registry.list().filter((tool) => tool.enabled);
  // ⚠️ **子代理不能派子代理** —— 防递归（见 [12-b B10](../docs/12-b-需求-对话与编排.md)）
  const pool = state.isolated ? enabled.filter((tool) => tool.executor !== 'none') : enabled;
  const query = lastUserText(state.messages);
  const selected = selectTools(pool, query, config);

  // ⚠️ **用户消息过注入检测** —— 命中只告警 + 收紧工具档，不直接拒答
  //    （见 [10 §10.7](../../docs/10-安全方案.md)）
  const scan = scanInjection(query);
  if (scan.detected) {
    logger.warn({ matches: scan.matches }, '用户消息里出现疑似提示词注入 —— 工具档已收紧');
  }
  const tools = scan.detected ? selected.map((tool) => tightenSensitivity(tool, scan)) : selected;

  // ── 上下文 ──
  const systemPrompt = buildSystemPrompt({
    tools: describeTools(tools.map((tool) => tool.name)),
    memories: state.memories || undefined,
    retrieval: state.retrieval || undefined,
    summary: state.summary || undefined,
    ...(state.skills ? { skills: state.skills } : {}),
    ...(personality ? { personality } : {}),
    // 📌 **项目指令（`AGENTS.md`）每轮现读** —— 改完下一轮就生效，不用重启
    //    （见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）
    agents: readAgentsInstructions(),
  });
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...state.messages];

  // 📌 **优先用网关登记的那份信号** —— LangGraph 组合出来的那个
  //    偶尔对不上（客户端断开时上游停不下来，白烧 token）；
  //    网关这份是**我们自己控制的**，一定准
  const externalSignal = requestSignal(state.messageId);
  const signal = externalSignal ?? runnableConfig.signal;

  // ⚠️ **客户端已经断开了就别再调模型** —— 白烧 token
  if (signal?.aborted) {
    return { messages: [], notice: null };
  }

  // ── 调模型（**一次流里出字 + 出工具调用**） ──
  // 📌 **带降级与故障转移** —— 供应商不支持思考 → 关掉思考重试；
  //    主模型报错 → 切备用模型（**只在还没吐过内容时切**）
  //    （见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）
  const fallback = resolveFallback();
  const chatModel = streamChatModel({
    primary: model,
    // ⚠️ **别拿同一个模型当备用** —— 会原地重试
    fallback: fallback && fallback.name !== model.name ? fallback : undefined,
    thinkingBudget,
    messages,
    tools: tools.length > 0 ? toLangChainTools(tools) : [],
    ...(signal ? { signal } : {}),
    onStrategyChange: (from, to, reason) => {
      logger.warn({ from, to, reason: reason.slice(0, 200) }, '模型策略变了');
      void writeAudit('MODEL_FALLBACK', 'model', to, {
        from,
        to,
        reason: reason.slice(0, 300),
        sessionId: state.sessionId,
      });
    },
  });

  const emit = getWriter(runnableConfig);

  let text = '';
  const toolCallChunks: Array<{ index?: number; id?: string; name?: string; args?: string }> = [];
  let usage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // 📌 **记账要用「真正跑出这一轮的那个模型」** —— 切过备用就不能记主模型的账
  let usedModel = model;

  for await (const item of chatModel) {
    if (runnableConfig.signal?.aborted) break;

    const piece = item.chunk as {
      text?: string;
      contentBlocks?: unknown;
      tool_call_chunks?: Array<{ index?: number; id?: string; name?: string; args?: string }>;
      usage_metadata?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    usedModel = item.model;

    const reasoning = readReasoningDelta(piece);
    if (reasoning) {
      emit?.({ type: 'reasoning-delta', delta: reasoning });
    }

    // ⚠️ **`.text` 只取文本块** —— 思考块走上面的 reasoning，不混进正文
    const delta = piece.text;
    if (delta) {
      text += delta;
      emit?.({ type: 'text-delta', delta });
    }

    if (piece.tool_call_chunks?.length) {
      toolCallChunks.push(...piece.tool_call_chunks);
    }

    const meta = piece.usage_metadata;
    if (meta) {
      // 📌 **取最大值，不取最后一个** —— 各家把用量放在不同的 chunk 上，
      //    取「到目前为止的最大值」才不会漏
      if (typeof meta.total_tokens === 'number') usage = Math.max(usage, meta.total_tokens);
      if (typeof meta.input_tokens === 'number') {
        inputTokens = Math.max(inputTokens, meta.input_tokens);
      }
      if (typeof meta.output_tokens === 'number') {
        outputTokens = Math.max(outputTokens, meta.output_tokens);
      }
    }
  }

  // ⚠️ **有些兼容端点在流式里不报输入 token** ——
  //    智谱的 Anthropic 兼容端点把 `input_tokens` 放在 `message_delta` 里，
  //    而 LangChain 的适配器只取 `output_tokens` → 流式下输入 token 直接丢了。
  //    **报 0 时按本地估算补上** —— 宁可估，也别让记账少一大半。
  if (inputTokens === 0) {
    const conversation = state.messages.map((message) => messageText(message)).join('\n');
    inputTokens = estimateTokens(`${systemPrompt}\n${conversation}`);
  }
  usage = inputTokens + outputTokens;
  // 📌 **每轮记一条成本** —— 预算闸的地基（见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）
  // ⚠️ **记真正跑的那个模型** —— 切过备用就不能记主模型的账
  if (inputTokens > 0 || outputTokens > 0) {
    void recordUsage({
      sessionId: state.sessionId ?? null,
      messageId: state.messageId ?? null,
      scope: 'chat',
      model: usedModel.name,
      inputTokens,
      outputTokens,
    });
  }

  const toolCalls = assembleToolCalls(toolCallChunks);
  const aiMessage = new AIMessage({
    id: nanoid(),
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });

  return {
    messages: [aiMessage],
    budgetUsed: usage,
    // 📌 **注入命中要带进权限闸** —— 只收紧给模型看的那份副本是空的
    injectionMatches: scan.detected ? scan.matches : [],
  };
}
