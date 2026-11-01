import { config } from '../config.js';
import type { Env } from '../config/schema.js';
import { resolveAuxModel, resolveModel, type ResolvedModel } from './model.js';

/**
 * 取「干脏活用的模型」—— **辅助模型优先，没有就用主模型**。
 *
 * 📌 **单独一个模块** —— 这样它对 `resolveModel` 的调用是**跨模块的**，
 *    测试里 `vi.mock('./model.js')` 能拦得住
 *    （写在 `model.ts` 内部的话就是模块内的本地调用，拦不住）。
 *
 * 📌 **哪些活算「脏活」** —— 记忆抽取 / 会话摘要 / 跨会话检索摘要 /
 *    技能沉淀判断 / cron 表达式解析。
 *    这些活输入长、输出短、不需要多强的推理，
 *    拿主模型（尤其开了思考的）干，**钱花得最冤**。
 *
 * ⚠️ **对话主路径不用它** —— 用户在问的问题要交给主模型。
 */
export function resolveUtilityModel(env: Env = config): ResolvedModel | undefined {
  return resolveAuxModel(env) ?? resolveModel(env);
}
