/**
 * 提示词注入检测 —— **概率性防线，不是唯一防线**
 * （见 [10 §10.7](../../docs/10-安全方案.md) 与 [12-e E4](../docs/12-e-需求-观测安全与验收.md)）。
 *
 * ⚠️ **命中只告警 + 收紧工具档，不直接拒答** ——
 * 误报会让 Agent 变哑巴，比漏报更招人烦。
 *
 * ⚠️ **安全不能只靠检测** —— 检测是概率性的，**确认闸门是确定性的**。
 */

/** 一条注入特征 */
export interface InjectionPattern {
  name: string;
  pattern: RegExp;
}

/** 注入特征表（**中英文都覆盖**） */
export const INJECTION_PATTERNS: InjectionPattern[] = [
  { name: '忽略之前的指令', pattern: /忽略(之前|上面|以上|前面)的?(所有)?(指令|要求|规则|提示)/ },
  { name: '忽略之前的指令', pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i },
  { name: 'disregard rules', pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+/i },
  { name: '你现在是', pattern: /(你现在|从现在起你)(是|扮演|当作)/ },
  { name: 'you are now', pattern: /you\s+are\s+now\s+(a|an|the)\s+/i },
  { name: '系统提示词', pattern: /(输出|重复|打印|泄露).{0,10}(系统提示|系统指令|初始指令|prompt)/ },
  { name: 'reveal prompt', pattern: /(reveal|print|repeat|show)\s+(your\s+)?(system\s+)?(prompt|instructions?)/i },
  { name: '绕过安全', pattern: /(绕过|关闭|解除|忽略).{0,6}(安全|限制|防护|确认|审核|规则)/ },
  { name: 'bypass safety', pattern: /bypass\s+(all\s+)?(safety|security|guardrails?|restrictions?)/i },
  { name: 'developer mode', pattern: /(developer\s+mode|开发者模式|jailbreak)/i },
  { name: '标记为系统消息', pattern: /<\/?\s*(system|assistant|user)\s*>|^\s*(system|assistant)\s*:/im },
];

/** 检测结果 */
export interface InjectionScan {
  /** 有没有命中 */
  detected: boolean;
  /** 命中的特征名（**去重**） */
  matches: string[];
}

/** 扫一段文本（**用户消息与工具结果都要过**） */
export function scanInjection(text: string): InjectionScan {
  const matches: string[] = [];
  for (const item of INJECTION_PATTERNS) {
    if (item.pattern.test(text) && !matches.includes(item.name)) {
      matches.push(item.name);
    }
  }
  return { detected: matches.length > 0, matches };
}

/**
 * 注入命中后**收紧工具档**（**不直接拒答**）。
 *
 * ⚠️ **只收紧，不拦** —— 命中注入不等于用户有恶意：
 * 用户可能正是在讨论「怎么防提示词注入」。
 */
export function tightenSensitivity<T extends { sensitivity: 'low' | 'normal' | 'high' }>(
  tool: T,
  scan: InjectionScan,
): T {
  if (!scan.detected) return tool;
  if (tool.sensitivity === 'high') return tool;
  return { ...tool, sensitivity: 'high' };
}
