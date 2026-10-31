import { scanInjection } from '../../lib/security/injection.js';
import { looksLikeSecret } from '../../lib/security/mask.js';
import { hasInvisibleChars } from '../../lib/security/invisible.js';

/**
 * 记忆写入前的扫描 —— **写盘前过一遍**（见 [12-e E4](../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **记忆层是持久化的注入通道** —— 对话层的注入检测只管当轮，
 * 记忆一旦写进去，**以后每一轮都会被注入**。
 * 所以记忆写入必须比对话更严：**命中就拒绝写入**（不是告警）。
 *
 * ⚠️ **三类要拦的**：
 * 1. **提示词注入** —— 「忽略之前的指令」这类
 * 2. **凭据外泄** —— 记忆里出现 API Key
 * 3. **不可见 Unicode** —— 零宽字符、双向控制符（能把文字「藏」起来）
 */

/** 扫描结果 */
export interface MemoryScanResult {
  /** 能写吗 */
  ok: boolean;
  /** 命中的原因（**能写时为空**） */
  reasons: string[];
}

/**
 * 扫一条要写进记忆的内容。
 *
 * 📌 **只扫模型抽出来的那部分** —— 用户手动编辑文件不受这条约束
 * （人自己写的东西不算「不可信输入」）。
 */
export function scanMemoryWrite(text: string): MemoryScanResult {
  const reasons: string[] = [];

  const injection = scanInjection(text);
  if (injection.detected) {
    reasons.push(`疑似提示词注入（${injection.matches.join('、')}）`);
  }

  if (looksLikeSecret(text)) {
    reasons.push('内容里像是有 API Key / 令牌');
  }

  if (hasInvisibleChars(text)) {
    reasons.push('内容里有不可见字符（零宽或双向控制符）');
  }

  return { ok: reasons.length === 0, reasons };
}
