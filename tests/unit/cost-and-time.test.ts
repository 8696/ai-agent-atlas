import { describe, expect, it } from 'vitest';
import { monthStartUtcString } from '../../src/lib/time';
import { estimateCost } from '../../src/services/cost';
import { estimateTokens } from '../../src/lib/tokens';

/**
 * 成本与时间的口径（见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ⚠️ **日期桶的口径要统一** —— UTC 墙钟存、按本地时区分桶。
 * 混用两套口径的症状是「每天的前 8 小时恒为 0」。
 */
describe('月度分桶（按本地时区）', () => {
  it('Asia/Shanghai 的月初 → 换算成 UTC 墙钟', () => {
    // 2026-10-31 12:00 +08:00 = 2026-10-31 04:00 UTC
    const now = new Date('2026-10-31T04:00:00.000Z');
    // 本地 10 月 1 日 00:00 = UTC 9 月 30 日 16:00
    expect(monthStartUtcString('Asia/Shanghai', now)).toBe('2026-09-30 16:00:00.000');
  });

  it('UTC 时区的月初就是 UTC 的月初', () => {
    const now = new Date('2026-10-31T04:00:00.000Z');
    expect(monthStartUtcString('UTC', now)).toBe('2026-10-01 00:00:00.000');
  });

  it('⚠️ 跨时区：月初边界不同（东八区已经进 11 月，UTC 还在 10 月）', () => {
    const now = new Date('2026-10-31T20:00:00.000Z');
    // 东八区：2026-11-01 04:00 → 本月是 11 月
    expect(monthStartUtcString('Asia/Shanghai', now)).toBe('2026-10-31 16:00:00.000');
    // UTC：还是 10 月
    expect(monthStartUtcString('UTC', now)).toBe('2026-10-01 00:00:00.000');
  });
});

/** 单价表（**构造一个假的，不依赖文件**） */
describe('费用估算', () => {
  const pricing = {
    models: {
      'fake-model': { inputPer1M: 1, outputPer1M: 2 },
    },
  };

  it('按输入 / 输出分别计价', () => {
    const cost = estimateCost('fake-model', 1_000_000, 1_000_000, pricing);
    expect(cost).toBe(3);
  });

  it('⚠️ 没配单价的模型 → 0（只记 token 数）', () => {
    expect(estimateCost('unknown-model', 1000, 1000, pricing)).toBe(0);
  });

  it('费用保留 6 位小数', () => {
    const cost = estimateCost('fake-model', 1, 1, pricing);
    expect(cost).toBe(0.000003);
  });
});

/** token 估算（**粗估，够用就行**） */
describe('token 估算', () => {
  it('中文约 1 token/字', () => {
    expect(estimateTokens('这是一段中文')).toBe(6);
  });

  it('英文约 4 字符/token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('空串 → 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
