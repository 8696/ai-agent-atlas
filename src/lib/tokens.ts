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

/**
 * 推理 token —— **端点不报的时候按「输出 token 减可见正文」估**。
 *
 * 📌 **为什么需要** ——
 * 有些 Anthropic 兼容端点**不单独返回推理 token**：
 * 智谱的实测就是 —— 带不带 `thinking` 参数，
 * `usage` 里都只有 `input_tokens` / `output_tokens`，
 * **但 `output_tokens` 已经把思考算进去了**
 * （同一个问题：带 thinking 77、无 thinking 64，差的就是思考量）。
 *
 * ⚠️ **估出来的值不是端点报的** ——
 *    调用方要能区分（会话日志里标 `reasoningEstimated`）。
 *
 * @param outputTokens 端点报的输出 token（**含思考**）
 * @param visibleText 可见的正文（**不含思考**）
 * @param reported 端点**单独报**的推理 token（0 = 没报）
 * @returns 推理 token
 */
export function estimateReasoningTokens(
  outputTokens: number,
  visibleText: string,
  reported: number,
): number {
  // 📌 **端点报了就用它** —— 那是准的
  if (reported > 0) return reported;
  if (outputTokens <= 0) return 0;
  // ⚠️ **别估出负数** —— 可见正文比输出 token 还长时（估算偏保守）会越界
  return Math.min(outputTokens, Math.max(0, outputTokens - estimateTokens(visibleText)));
}
