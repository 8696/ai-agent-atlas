import { config } from '../config.js';
import { estimateTokens } from '../lib/tokens.js';
import { getToolRegistry } from '../tools/registry.js';
import { matchSkills, type SkillHit } from './match.js';
import type { Skill } from './types.js';

/**
 * 技能注入 —— **命中的技能正文进系统提示词**
 * （见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **双重裁剪**：条数（`SKILL_TOP_K`）+ token 预算（`SKILL_TOKEN_BUDGET`）。
 * ⚠️ **返回空串表示「没有可注入的技能」** —— 调用方据此跳过这一段。
 *
 * 📌 **自动沉淀的技能要标出来** —— 「（自动沉淀，未经人工确认）」，
 * 让模型知道这条描述可能不准（可信度低）。
 */

/** 自动沉淀技能的标记 */
const AUTO_CREATED_NOTE = '（自动沉淀，未经人工确认）';

/**
 * 这个技能的脚本工具叫什么（**问注册表，别自己拼** ——
 * 工具名冲突时会被改名）。
 */
function scriptToolName(skill: Skill): string | undefined {
  try {
    return getToolRegistry().get(`skill_${skill.meta.name}`)?.name;
  } catch {
    return undefined;
  }
}

/** 一个技能渲染成的那段 */
function renderSkill(skill: Skill): string {
  const lines: string[] = [`### ${skill.meta.name}`];
  if (skill.meta.description) lines.push(`适用场景：${skill.meta.description}`);
  if (skill.meta.autoCreated) lines.push(AUTO_CREATED_NOTE);
  if (skill.body) lines.push('', skill.body);

  if (skill.scripts.length > 0) {
    const toolName = scriptToolName(skill);
    if (toolName) {
      lines.push(
        '',
        `可用脚本（用 \`${toolName}\` 工具执行）：${skill.scripts.map((s) => `\`${s}\``).join(' · ')}`,
      );
    } else {
      lines.push('', `可用脚本（**重启后生效**）：${skill.scripts.map((s) => `\`${s}\``).join(' · ')}`);
    }
  }

  if (skill.meta.sensitivity === 'high') {
    lines.push('', '⚠️ **执行这个技能的脚本需要你确认** —— 确认卡片会说明要跑什么。');
  }
  return lines.join('\n');
}

/**
 * 组装注入系统提示词的那段技能。
 *
 * ⚠️ **技能说明是「不可信内容」的边界** —— 技能是用户手动装进来的，
 * 但正文里可能藏着指令，所以正文用围栏包起来，模型能看出这是「资料」不是「系统指令」。
 */
export async function buildSkillSection(query: string): Promise<string> {
  const hits = await matchSkills(query);
  if (hits.length === 0) return '';

  const budget = Math.max(1, config.SKILL_TOKEN_BUDGET);
  const chosen: SkillHit[] = [];
  let used = 0;
  for (const hit of hits) {
    const cost = estimateTokens(renderSkill(hit.skill));
    // ⚠️ **至少塞一条** —— 哪怕超预算（一条短说明挤掉整条技能更糟）
    if (chosen.length > 0 && used + cost > budget) break;
    chosen.push(hit);
    used += cost;
  }

  if (chosen.length === 0) return '';

  const blocks = chosen.map((hit) => renderSkill(hit.skill));
  return [
    '## 可用技能',
    '',
    '下面是与你当前问题相关的技能说明。**按需使用** —— 用得上才照它的步骤做，用不上就忽略。',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
