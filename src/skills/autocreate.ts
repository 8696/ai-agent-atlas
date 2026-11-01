import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { join } from 'node:path';
import { config } from '../config.js';
import { DIRS } from '../config/paths.js';
import { logger } from '../logger.js';
import { writeAudit } from '../lib/audit.js';
import { createChatModel } from '../services/model.js';
import { resolveUtilityModel } from '../services/model-utility.js';
import { recordUsage, usageOf } from '../services/cost.js';
import { recordToolCall } from '../services/tool-log.js';
import { readTextFile } from '../services/prompt.js';
import { toLangChainTools } from '../tools/registry.js';
import { createSkill, getSkill, updateSkill } from './store.js';
import { skillCreateTool, skillUpdateTool } from './tools.js';

/**
 * 技能自演化 —— **干完一件复杂的事，Agent 自己把经验写成技能**
 * （见 [12-c C4.2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **每轮结束后异步问模型一句** —— 不阻塞本轮回答。
 * ⚠️ **复杂度门槛**：本轮工具调用次数 ≥ `SKILL_MIN_TOOL_CALLS`（默认 5）才问 ——
 * **闲聊（0 次工具调用）不该沉淀技能**，否则 `data/skills/` 会被垃圾填满。
 *
 * 📌 **模型用 `skill_create` / `skill_update` 两个工具表达决定** ——
 * 与对话里的工具**同一套接口、同一套写盘逻辑、同一套安全扫描**。
 *
 * ⚠️ **节制**：
 * - 每轮**最多自动创建 1 个**技能
 * - 同一技能 **24 小时内不重复自动更新**
 * - `SKILL_AUTOCREATE_ENABLED=false` → 完全关闭
 */

/** 同一技能的自动更新冷却（**24 小时**） */
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 结果 */
export interface AutocreateResult {
  /** 建出来的技能名 */
  created: string | null;
  /** 改掉的技能名 */
  updated: string | null;
  /** 没成的原因（**给日志看**） */
  note: string;
}

/** 已经跑过的轮次（**一轮最多建一个**） */
const handledTurns = new Set<string>();

/** 测试用：清掉「这一轮已经处理过」的记录 */
export function resetAutocreateTurns(): void {
  handledTurns.clear();
}

/** 这个技能是不是还在冷却期里 */
export function inCooldown(skillName: string): boolean {
  const skill = getSkill(skillName);
  const stamp = skill?.meta.autoUpdatedAt;
  if (!stamp) return false;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return false;
  return Date.now() - at < COOLDOWN_MS;
}

/** 沉淀用的系统提示词 */
function autocreatePrompt(): string {
  const base = readTextFile(join(DIRS.prompts, 'skill.md')).trim();
  return [
    base,
    '',
    '## 判定标准',
    '',
    '- **值得沉淀**：这轮的流程里有「下次还会用到的固定套路」',
    '  （比如「生成某类报告的固定步骤」「某个服务总是这么启动」）。',
    '- **不值得**：一次性的数据、只跟这一次请求有关的内容、通用常识。',
    '',
    '⚠️ **不值得就什么都别干** —— 不要调用任何工具，直接回答「没有」。',
    '⚠️ **不要把具体数据写进技能** —— 技能是「做法」，不是「这次的结果」。',
  ].join('\n');
}

/** 从模型回复里取出工具调用 */
function toolCallsOf(reply: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  const calls = (reply as AIMessage | null)?.tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const name = (call as { name?: unknown }).name;
    const args = (call as { args?: unknown }).args;
    if (typeof name !== 'string') continue;
    out.push({
      name,
      args:
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

/** 取一个字符串字段 */
function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 跑一轮技能自演化（**fire-and-forget**）。
 *
 * @param input.userText 这一轮的用户输入
 * @param input.assistantText 这一轮的回答
 * @param input.toolCallCount 这一轮的工具调用次数（**门槛就看它**）
 * @param input.turnId 这一轮的标识（**用来保证一轮只建一个**）
 */
export async function runSkillAutocreate(input: {
  userText: string;
  assistantText: string;
  toolCallCount: number;
  turnId?: string | undefined;
}): Promise<AutocreateResult> {
  const none = (note: string): AutocreateResult => ({ created: null, updated: null, note });

  // ── 总开关 ──
  if (!config.SKILL_AUTOCREATE_ENABLED) return none('自动沉淀已关闭');

  // ⚠️ **复杂度门槛** —— 工具调用太少不沉淀（闲聊不该沉淀）
  if (input.toolCallCount < config.SKILL_MIN_TOOL_CALLS) {
    return none(`工具调用 ${input.toolCallCount} 次 < 门槛 ${config.SKILL_MIN_TOOL_CALLS}`);
  }

  // ⚠️ **一轮最多建一个** —— 别让模型一口气造一堆技能
  const turnId = input.turnId ?? `${input.userText.slice(0, 32)}:${input.toolCallCount}`;
  if (handledTurns.has(turnId)) return none('这一轮已经处理过了');
  handledTurns.add(turnId);
  // ⚠️ **集合别无限涨** —— 只记最近的几轮
  if (handledTurns.size > 200) {
    const first = handledTurns.values().next();
    if (!first.done) handledTurns.delete(first.value);
  }

  const model = resolveUtilityModel();
  if (!model) return none('还没配置模型');

  // ── 问模型「这轮有没有值得沉淀的经验」 ──
  let reply: unknown;
  try {
    const chat = await createChatModel(model);
    const bound = chat.bindTools(
      toLangChainTools([skillCreateTool, skillUpdateTool]) as never[],
    );
    reply = await bound.invoke([
      new SystemMessage(autocreatePrompt()),
      new HumanMessage(
        [
          '## 这一轮对话',
          '',
          `用户：${input.userText}`,
          `助手：${input.assistantText}`,
          '',
          `（本轮工具调用了 ${input.toolCallCount} 次）`,
        ].join('\n'),
      ),
    ]);
  } catch (err) {
    logger.warn({ err }, '技能沉淀调用失败 —— 跳过本轮');
    return none('模型调用失败');
  }

  // 📌 **这次调用的花费单独记一条**（`usage_scope='skill'`）
  const meta = usageOf(reply);
  if (meta.inputTokens > 0 || meta.outputTokens > 0) {
    void recordUsage({
      sessionId: null,
      messageId: null,
      scope: 'skill',
      model: model.name,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      reasoningTokens: meta.reasoningTokens,
      cachedTokens: meta.cachedTokens,
    });
  }

  const calls = toolCallsOf(reply);
  if (calls.length === 0) return none('模型认为没什么可沉淀的');

  // ⚠️ **一轮只处理第一个调用** —— 剩下的丢掉
  const call = calls[0];
  if (!call) return none('没有可执行的调用');

  if (call.name === 'skill_create') {
    const name = str(call.args, 'name').trim();
    const description = str(call.args, 'description').trim();
    const body = str(call.args, 'body').trim();
    if (!name || !description || !body) {
      return none('模型给的参数不完整（name / description / body 缺一不可）');
    }
    const result = await createSkill({ name, description, body });
    if (!result.ok) {
      await writeAudit('SKILL_AUTOCREATED', 'skill', name, { rejected: true, reason: result.reason });
      logger.warn({ name, reason: result.reason }, '自动沉淀的技能被拒绝写入');
      await recordToolCall({
        toolName: 'skill_create',
        source: 'skill',
        status: 'rejected',
        args: { name, description },
        error: result.reason ?? '写入被拒',
      });
      return none(result.reason ?? '写入被拒');
    }
    // 📌 **也要记流水** —— 自动沉淀不走工具执行层，
    //    不记的话「工具调用流水」就漏了这条（见 [12-c C6](../docs/12-c-需求-工具技能与扩展.md)）
    await recordToolCall({
      toolName: 'skill_create',
      source: 'skill',
      status: 'success',
      args: { name, description },
      output: `已创建技能「${name}」（自动沉淀）`,
      requiresConfirmation: false,
    });
    logger.info({ name }, '自动沉淀了一个技能');
    return { created: name, updated: null, note: '已创建' };
  }

  if (call.name === 'skill_update') {
    const name = str(call.args, 'name').trim();
    const body = str(call.args, 'body').trim();
    if (!name || !body) return none('模型给的参数不完整（name / body 缺一不可）');
    // ⚠️ **24 小时冷却** —— 同一个技能别被反复自动改
    if (inCooldown(name)) {
      return none(`技能「${name}」24 小时内已经自动更新过，跳过`);
    }
    const result = await updateSkill(name, body, { touched: true });
    if (!result.ok) {
      await writeAudit('SKILL_AUTOUPDATED', 'skill', name, { rejected: true, reason: result.reason });
      logger.warn({ name, reason: result.reason }, '自动更新的技能被拒绝写入');
      await recordToolCall({
        toolName: 'skill_update',
        source: 'skill',
        status: 'rejected',
        args: { name },
        error: result.reason ?? '写入被拒',
      });
      return none(result.reason ?? '写入被拒');
    }
    // 📌 **也要记流水** —— 同上（见 [12-c C6](../docs/12-c-需求-工具技能与扩展.md)）
    await recordToolCall({
      toolName: 'skill_update',
      source: 'skill',
      status: 'success',
      args: { name },
      output: `已更新技能「${name}」（自动沉淀）`,
      requiresConfirmation: false,
    });
    logger.info({ name }, '自动更新了一个技能');
    return { created: null, updated: name, note: '已更新' };
  }

  return none(`模型调了不认识的工具：${call.name}`);
}
