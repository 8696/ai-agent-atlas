import { nanoid } from 'nanoid';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { getWriter } from '@langchain/langgraph';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { scanInjection, tightenSensitivity } from '../../lib/security/injection.js';
import { disabledTools } from '../../lib/security/policy.js';
import { estimateTokens } from '../../lib/tokens.js';
import { writeAudit } from '../../lib/audit.js';
import {
  buildSystemPrompt,
  promptFallbackNotice,
  readAgentsInstructions,
  systemMessage,
} from '../../services/prompt.js';
import {
  resolveFallback,
  resolveModel,
  type ResolvedModel,
} from '../../services/model.js';
import { streamChatModel, readReasoningDelta } from '../model-stream.js';
import { canSpawnSubagent } from '../subagent.js';
import { recordUsage } from '../../services/cost.js';
import { getSessionSettings } from '../../services/session.js';
import { requestSignal } from '../abort.js';
import { getToolRegistry, toLangChainTools } from '../../tools/registry.js';
import { selectTools } from '../../tools/selection.js';
import { assembleToolCalls } from '../tool-calls.js';
import { messageText } from '../../services/chat-messages.js';
import { describeMessages, logEvent, turnIdOf } from '../../services/turn-log/emit.js';
import { describeToolDefs, describeToolCalls } from '../../services/turn-log/describe.js';
import type { AtlasStateUpdate } from '../state.js';
import type { UsageScope } from '../../models/cost-log.model.js';

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
    logTurnId?: string | undefined;
    isolated?: boolean | undefined;
    model?: string | undefined;
    usageScope?: UsageScope | undefined;
    /** ⚠️ **当前是第几层代理**（0 = 主代理）—— 判「还能不能再派一层」 */
    depth?: number | undefined;
    /** ⚠️ **本轮已经用掉的 token** —— 判单轮上限 */
    turnTokens?: number | undefined;
    /** ⚠️ **本轮已走的步数** —— 日志用它区分「同一轮里的第几次调模型」 */
    steps?: number | undefined;
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
  // ⚠️ **被全局开关禁用的工具不进池** —— 模型不该看见一个必然失败的工具
  //    （`SHELL_ENABLED=false` → 模型**根本看不到** `shell`，
  //    而不是「看得见但一调就报错」—— 见 [12-b B3](../docs/12-b-需求-对话与编排.md)）
  const disabled = disabledTools(config);
  const enabled = registry.list().filter((tool) => tool.enabled && !disabled.has(tool.name));
  // ⚠️ **子代理不能调「不可被子代理调用」的工具**（如 `memory_forget`）
  // 📌 **深度上限之内可以再派** —— `SUBAGENT_MAX_DEPTH`（默认 2）：
  //    「并行调研 → 汇总 → 成稿」这种三层活才做得成；
  //    到了上限就把 `spawn_subagent` 从池子里拿掉 —— **模型看不见它**。
  const depth = state.depth ?? 0;
  const canSpawn = canSpawnSubagent(depth);
  const pool = enabled.filter((tool) => {
    if (state.isolated && tool.executor === 'none') return false;
    if (tool.name === 'spawn_subagent' && !canSpawn) return false;
    return true;
  });
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
  // 📌 **提示词缓存**（`.env` 的 `LLM_PROMPT_CACHE`）——
  //    系统提示词每轮重复注入，命中缓存按打折价计费；
  //    端点不支持会自动退回不缓存（见 `agent/model-stream.ts`）
  const messages: BaseMessage[] = [
    systemMessage(systemPrompt, config.LLM_PROMPT_CACHE),
    ...state.messages,
  ];

  // 📌 **这一轮的第几次调模型**（**日志的幂等键要用**）——
  //    `steps` 在图状态里单调递增（每跑完一批工具 +1），
  //    所以它能区分同一轮里的多次模型调用。
  const llmCallIndex = state.steps ?? 0;
  const logTurnId = turnIdOf(state);
  const loggable = Boolean(state.sessionId && logTurnId);

  // 📌 **模型请求记进会话日志**（**完整请求体**）
  //    —— 「到底给模型发了什么」只能在这儿看
  //    （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）
  if (loggable) {
    logEvent({
      turnId: logTurnId,
      sessionId: state.sessionId as string,
      type: 'llm.request',
      eventKey: `llm.request:${llmCallIndex}`,
      title: `第 ${llmCallIndex + 1} 次调模型`,
      payload: {
        model: model.name,
        modelId: model.modelId,
        baseUrl: model.baseUrl ?? null,
        temperature: model.temperature,
        maxTokens: model.maxTokens,
        thinkingBudget,
        cacheEnabled: config.LLM_PROMPT_CACHE,
        tools: describeToolDefs(tools),
        systemPrompt,
        messages: describeMessages(messages),
        injectionMatches: scan.matches,
      },
    });
  }

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
    // 📌 **提示词缓存** —— 端点不支持会自动退回不缓存
    cacheEnabled: config.LLM_PROMPT_CACHE,
    ...(signal ? { signal } : {}),
    onStrategyChange: (from, to, reason) => {
      logger.warn({ from, to, reason: reason.slice(0, 200) }, '模型策略变了');
      void writeAudit('MODEL_FALLBACK', 'model', to, {
        from,
        to,
        reason: reason.slice(0, 300),
        sessionId: state.sessionId,
      });
      // 📌 **降级也记进会话日志** —— 「为什么答案突然变差了」就靠这条
      if (loggable) {
        logEvent({
          turnId: logTurnId,
          sessionId: state.sessionId as string,
          type: 'model.fallback',
          eventKey: `model.fallback:${llmCallIndex}:${from}->${to}`,
          title: `模型策略变了：${from} → ${to}`,
          payload: { from, to, reason },
        });
      }
    },
  });

  const emit = getWriter(runnableConfig);

  // 📌 **「用了兜底提示词」要显式说一声** —— 不要静默降级
  //    （见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）
  const fallbackNotice = promptFallbackNotice();
  if (fallbackNotice) emit?.({ type: 'notice', text: fallbackNotice });

  let text = '';
  // 📌 **思考文本也攒起来** —— 日志里要看得见「它想了什么」
  let reasoningText = '';
  const toolCallChunks: Array<{ index?: number; id?: string; name?: string; args?: string }> = [];
  let usage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // 📌 **推理 token / 缓存 token 单列** —— 成本报表要能拆开看
  let reasoningTokens = 0;
  let cachedTokens = 0;
  // 📌 **记账要用「真正跑出这一轮的那个模型」** —— 切过备用就不能记主模型的账
  let usedModel = model;

  for await (const item of chatModel) {
    if (runnableConfig.signal?.aborted) break;

    const piece = item.chunk as {
      text?: string;
      contentBlocks?: unknown;
      tool_call_chunks?: Array<{ index?: number; id?: string; name?: string; args?: string }>;
      usage_metadata?: {
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        output_token_details?: { reasoning?: number };
        input_token_details?: { cache_read?: number; cache_creation?: number };
      };
    };
    usedModel = item.model;

    const reasoning = readReasoningDelta(piece);
    if (reasoning) {
      reasoningText += reasoning;
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
      // 📌 **推理 token 与缓存 token 也要记** ——
      //    以前只取前三个，推理 token 一条都没落库，
      //    `/usage` 与 `yarn cost:report` 的「推理」那一行永远是空的
      //    （见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）
      const outputDetails = meta.output_token_details as { reasoning?: number } | undefined;
      if (typeof outputDetails?.reasoning === 'number') {
        reasoningTokens = Math.max(reasoningTokens, outputDetails.reasoning);
      }
      const inputDetails = meta.input_token_details as
        | { cache_read?: number; cache_creation?: number }
        | undefined;
      if (typeof inputDetails?.cache_read === 'number') {
        cachedTokens = Math.max(cachedTokens, inputDetails.cache_read);
      }
      if (typeof inputDetails?.cache_creation === 'number') {
        cachedTokens = Math.max(cachedTokens, inputDetails.cache_creation);
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
      // 📌 **按这一轮的用途分桶** —— 定时任务记 `cron`，跟普通对话分开
      //    （见 [12-b B11](../docs/12-b-需求-对话与编排.md)）
      scope: state.usageScope || 'chat',
      model: usedModel.name,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
    });
  }

  const toolCalls = assembleToolCalls(toolCallChunks);
  const aiMessage = new AIMessage({
    id: nanoid(),
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });

  // 📌 **模型响应记进会话日志**（**完整响应体**）
  //    —— 与 `llm.request` 一起构成「这一轮模型的完整往返」
  //    （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）
  if (loggable) {
    logEvent({
      turnId: logTurnId,
      sessionId: state.sessionId as string,
      type: 'llm.response',
      eventKey: `llm.response:${llmCallIndex}`,
      title: `第 ${llmCallIndex + 1} 次模型响应`,
      payload: {
        model: usedModel.name,
        text,
        reasoning: reasoningText,
        toolCalls: describeToolCalls(toolCalls),
        usage: {
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedTokens,
          totalTokens: inputTokens + outputTokens,
        },
      },
    });
  }

  return {
    messages: [aiMessage],
    budgetUsed: usage,
    // 📌 **本轮累计** —— 单轮上限按「这一轮」算（不是整个会话）
    turnTokens: (state.turnTokens ?? 0) + usage,
    // 📌 **注入命中要带进权限闸** —— 只收紧给模型看的那份副本是空的
    injectionMatches: scan.detected ? scan.matches : [],
  };
}
