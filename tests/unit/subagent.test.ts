import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/agent/subagent-pool';
import { spawnSubagentTool, subagentThreadId } from '../../src/agent/subagent';

/**
 * 子代理的单元测试 —— **并发闸与工具元信息**。
 *
 * 覆盖（[12-b B10](../../docs/12-b-需求-对话与编排.md)）：
 * - 并发超过上限 → **排队**，不失败
 * - 子代理的 thread_id 稳定（父图恢复时不能换）
 * - 子代理不能再派子代理
 */

describe('子代理并发闸', () => {
  it('没到上限 → 立刻拿到名额', async () => {
    const gate = new Semaphore(2);
    await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(0);
  });

  it('⚠️ 超过上限 → 排队（不是报错）', async () => {
    const gate = new Semaphore(1);
    await gate.acquire();
    expect(gate.activeCount).toBe(1);

    let got = false;
    const waiting = gate.acquire().then(() => {
      got = true;
    });

    // ⚠️ **还在排队** —— 没拿到名额
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(got).toBe(false);
    expect(gate.queuedCount).toBe(1);

    // 📌 **前面那个让出名额 → 排队的拿到**
    gate.release();
    await waiting;
    expect(got).toBe(true);
    expect(gate.activeCount).toBe(1);
  });

  it('上限至少是 1', () => {
    expect(new Semaphore(0).capacity).toBe(1);
    expect(new Semaphore(-5).capacity).toBe(1);
  });
});

describe('子代理工具', () => {
  it('⚠️ 子代理不能再派子代理（防递归）', () => {
    expect(spawnSubagentTool.executor).toBe('none');
  });

  it('派发本身走统一权限闸（不是自己偷偷跑）', () => {
    expect(spawnSubagentTool.source).toBe('builtin');
    expect(spawnSubagentTool.enabled).toBe(true);
    expect(spawnSubagentTool.sensitivity).toBe('normal');
  });

  it('⚠️ 同一个工具调用 → 同一个 thread_id（父图恢复时不能换）', () => {
    const a = subagentThreadId('sess-1', 'call-1');
    const b = subagentThreadId('sess-1', 'call-1');
    const c = subagentThreadId('sess-1', 'call-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('subagent:')).toBe(true);
  });
});
