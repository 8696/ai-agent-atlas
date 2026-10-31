/**
 * Token 估算 —— **粗估，不追求精确**。
 *
 * 📌 **为什么需要它**：摘要压缩、召回裁剪、预算闸都要判断「这段有多长」。
 * 真算 token 要调 tokenizer（多一个依赖），而本地单用户场景
 * **估算够用** —— 估得偏保守一点就行。
 *
 * ⚠️ **口径**：
 * - 中文 / 全角字符 ≈ **1 token/字**
 * - 英文 ≈ **4 字符/token**
 *
 * 📌 **故意往大了估** —— 预算宁可早一点触发，不要超了才发现。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // ⚠️ **CJK 统一表意文字 + 日文假名 + 韩文 + 全角标点**
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
      continue;
    }
    other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 一组文本的 token 估算之和 */
export function estimateTokensOf(...texts: string[]): number {
  let total = 0;
  for (const text of texts) total += estimateTokens(text);
  return total;
}
