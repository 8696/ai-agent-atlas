import { ChatAnthropic } from '@langchain/anthropic';
import { config } from '../config';
import type { Env } from '../config/schema';

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
 */
export function createChatModel(model: ResolvedModel): ChatAnthropic {
  if (!model.apiKey) {
    throw new Error(
      `模型「${model.name}」缺少 API Key —— 检查 .env 里的 LLM_API_KEY`,
    );
  }
  const budget = resolveThinkingBudget(model);
  const thinkingOn = budget > 0;
  return new ChatAnthropic({
    model: model.modelId,
    anthropicApiKey: model.apiKey,
    ...(model.baseUrl ? { anthropicApiUrl: model.baseUrl } : {}),
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
