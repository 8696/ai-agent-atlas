import { ChatAnthropic } from '@langchain/anthropic';
import { config } from '../config.js';
import type { Env } from '../config/schema.js';
import { assertModelEndpointReachable, isLoopbackUrl } from '../lib/security/model-endpoint.js';

/**
 * 模型解析 —— **全项目唯一一处**拿模型的地方。
 *
 * 对话 / 记忆抽取 / 摘要 都从这里走，
 * ⚠️ **不许各处自己 new ChatModel**（那会让「换模型」变成全局搜索改造）。
 *
 * 🎯 **只有一个模型，纯标量配置** —— 一个 Base URL + 一个 Key + 一个模型标识：
 *
 * ```dotenv
 * LLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
 * LLM_API_KEY=sk-xxxx
 * LLM_MODEL=glm-5.3
 * ```
 *
 * 四家国产模型（智谱 / MiniMax / DeepSeek / 千问）**全都提供 Anthropic 兼容端点**
 * → 只需要一个 `anthropic` 适配器，**换供应商 = 改这三行，不改代码**。
 */

/** 展开后的模型定义 */
export interface ResolvedModel {
  /** 展示名（默认取模型标识） */
  name: string;
  /** Anthropic 兼容端点 */
  baseUrl?: string | undefined;
  /** API Key */
  apiKey?: string | undefined;
  /** 模型标识 */
  modelId: string;
  /** 单次输出上限 */
  maxTokens: number;
  /** 采样温度 */
  temperature: number;
  /** 推理预算（0 = 关） */
  thinkingBudget: number;
}

/** 取主模型（没配就是 undefined → 运行时提示「还没配置模型」） */
export function resolveModel(env: Env = config): ResolvedModel | undefined {
  if (!env.LLM_MODEL) return undefined;
  return {
    name: env.LLM_MODEL,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    modelId: env.LLM_MODEL,
    maxTokens: env.LLM_MAX_TOKENS,
    temperature: env.LLM_TEMPERATURE,
    thinkingBudget: env.LLM_THINKING_BUDGET,
  };
}

/** 取备用模型（**没配就是没有**） */
export function resolveFallback(env: Env = config): ResolvedModel | undefined {
  if (!env.LLM_FALLBACK_MODEL) return undefined;
  return {
    name: env.LLM_FALLBACK_MODEL,
    baseUrl: env.LLM_FALLBACK_BASE_URL,
    apiKey: env.LLM_FALLBACK_API_KEY,
    modelId: env.LLM_FALLBACK_MODEL,
    maxTokens: env.LLM_MAX_TOKENS,
    temperature: env.LLM_TEMPERATURE,
    thinkingBudget: env.LLM_THINKING_BUDGET,
  };
}

/**
 * 取辅助模型（**没配就是没有** —— 调用方回落到主模型）。
 *
 * 📌 **辅助模型干「脏活」** —— 记忆抽取 / 会话摘要 / 检索摘要 /
 *    技能沉淀判断 / cron 表达式解析。
 *    这些活输入长、输出短、不需要多强的推理，
 *    拿主模型（尤其开了思考的）干，**钱花得最冤**。
 */
export function resolveAuxModel(env: Env = config): ResolvedModel | undefined {
  if (!env.LLM_AUX_MODEL) return undefined;
  return {
    name: env.LLM_AUX_MODEL,
    baseUrl: env.LLM_AUX_BASE_URL,
    apiKey: env.LLM_AUX_API_KEY,
    modelId: env.LLM_AUX_MODEL,
    maxTokens: env.LLM_MAX_TOKENS,
    temperature: env.LLM_TEMPERATURE,
    // ⚠️ **辅助模型不思考** —— 「脏活」不需要推理，省下的都是真金白银
    thinkingBudget: 0,
  };
}

/**
 * 推理预算 —— 只看 `.env` 的 `LLM_THINKING_BUDGET`。
 * 大于 0 就开，0 就关。聊天页没有开关。
 */
export function resolveThinkingBudget(model: ResolvedModel): number {
  return model.thinkingBudget;
}

/**
 * 建 ChatModel。
 *
 * ⚠️ **Anthropic 适配器覆盖了四家国产模型** ——
 * 它们都提供 Anthropic 兼容端点（`anthropicApiUrl`），行为一致：
 * 标准 `/v1/messages` · 标准 SSE 事件 · 标准 `thinking` 块 · 标准 tool_use。
 *
 * 📌 **每次建模型都重新校验端点** —— 启动时校验一次不够，
 * 域名可能被劫持到内网 / 云元数据地址（见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 📌 **本地端点可以没有 API Key** —— 本地模型（Ollama / LM Studio / vLLM）
 * 没有 Key 这回事，塞一个占位串即可（适配器要求非空）。
 */
export async function createChatModel(model: ResolvedModel): Promise<ChatAnthropic> {
  // ⚠️ **端点校验在每次调用前做** —— 域名解析结果可能变了
  if (model.baseUrl) {
    await assertModelEndpointReachable(model.baseUrl);
  }
  if (!model.apiKey && !isLoopbackUrl(model.baseUrl)) {
    throw new Error(`模型「${model.name}」缺少 API Key —— 检查 .env 里的 LLM_API_KEY`);
  }
  const budget = resolveThinkingBudget(model);
  const thinkingOn = budget > 0;
  return new ChatAnthropic({
    model: model.modelId,
    // ⚠️ **本地端点没有 Key** —— 给个占位串，适配器不接受空串
    anthropicApiKey: model.apiKey ?? 'local-no-key',
    ...(model.baseUrl ? { anthropicApiUrl: model.baseUrl } : {}),
    // ⚠️ **流式也要带用量** —— 不开的话最后一个 chunk 的 `usage_metadata`
    // 只有输出 token（输入 token 在 `message_start` 里，流式不重复给），
    // 记账就会少记一大半（见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）
    streamUsage: true,
    // ⚠️ **开了思考就不能再传自定义温度** —— Anthropic 要求 temperature = 1，
    //    否则适配器直接抛错，这一轮连正文都出不来
    temperature: thinkingOn ? 1 : model.temperature,
    // ⚠️ **Anthropic 要求 `max_tokens > thinking.budget_tokens`** —— 400 就来了
    //    这里把上限抬到「预算 + 余量」
    ...(thinkingOn
      ? {
          maxTokens: Math.max(model.maxTokens, budget + 1024),
          thinking: { type: 'enabled' as const, budget_tokens: budget },
        }
      : { maxTokens: model.maxTokens }),
  });
}

/** 有没有可用模型（前端「还没配置模型」空状态用） */
export function hasUsableModel(env: Env = config): boolean {
  return resolveModel(env) !== undefined;
}
