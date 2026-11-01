import { describe, expect, it } from 'vitest';
import { estimateReasoningTokens, estimateTokens } from '../../src/lib/tokens';

/**
 * **推理 token 估算**的单元测试（见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **为什么需要** ——
 * 有些 Anthropic 兼容端点**不单独返回推理 token**
 * （智谱实测：带不带 `thinking` 参数，`usage` 里都只有 input / output），
 * 但 `output_tokens` 已经把思考算进去了。
 * → 不估的话 `/usage` 与 `yarn cost:report` 的「推理」那一行永远是空的。
 */

describe('推理 token 估算', () => {
  it('📌 **端点报了就用端点报的**（那是准的）', () => {
    expect(estimateReasoningTokens(100, '一段正文', 40)).toBe(40);
  });

  it('📌 **端点没报 → 用「输出 token 减可见正文」估**', () => {
    // 输出 100 token，其中正文约 10 token → 思考约 90
    const visible = '短';
    const reasoning = estimateReasoningTokens(100, visible, 0);
    expect(reasoning).toBe(100 - estimateTokens(visible));
    expect(reasoning).toBeGreaterThan(0);
  });

  it('⚠️ **估不出负数**（可见正文比输出 token 还长时）', () => {
    const longText = 'x'.repeat(4000);
    expect(estimateReasoningTokens(10, longText, 0)).toBe(0);
  });

  it('⚠️ **估不出超过输出 token 的值**', () => {
    expect(estimateReasoningTokens(50, '', 0)).toBe(50);
  });

  it('⚠️ **输出 token 是 0 → 推理也是 0**', () => {
    expect(estimateReasoningTokens(0, '正文', 0)).toBe(0);
  });
});
