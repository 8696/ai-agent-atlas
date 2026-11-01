import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/agent/subagent-pool';
import {
  canSpawnSubagent,
  parseJsonObject,
  spawnSubagentTool,
  subagentThreadId,
} from '../../src/agent/subagent';

/**
 * 子代理的单元测试 —— **并发闸与工具元信息**。
 *
 * 覆盖（[12-b B10](../../docs/12-b-需求-对话与编排.md)）：
 * - 并发超过上限 → **排队**，不失败
 * - 子代理的 thread_id 稳定（父图恢复时不能换）
 * - 子代理能再派一层（**限深度** —— 到顶那一层就看不见这个工具）
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
  it('📌 子代理能再派一层（限深度，不是彻底禁掉）', () => {
    expect(spawnSubagentTool.executor).toBe('subagent');
  });

  it('⚠️ 深度到顶 → 那一层不能再派（防递归）', () => {
    // 📌 **默认上限 2** —— 主代理 → 子代理 → 孙代理
    expect(canSpawnSubagent(0)).toBe(true);
    expect(canSpawnSubagent(1)).toBe(true);
    expect(canSpawnSubagent(2)).toBe(false);
    expect(canSpawnSubagent(3)).toBe(false);
  });

  it('⚠️ 上限调成 1 → 只有主代理能派', () => {
    expect(canSpawnSubagent(0, 1)).toBe(true);
    expect(canSpawnSubagent(1, 1)).toBe(false);
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

  it('⚠️ 不同深度的子代理 → 不同 thread_id（检查点不能串）', () => {
    const a = subagentThreadId('sess-1', 'call-1', 1);
    const b = subagentThreadId('sess-1', 'call-1', 2);
    expect(a).not.toBe(b);
  });
});

describe('子代理的结构化产出', () => {
  it('📌 纯 JSON → 解析出来', () => {
    const parsed = parseJsonObject('{"summary":"结论","items":[1,2]}');
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual({ summary: '结论', items: [1, 2] });
  });

  it('📌 包在代码块围栏里 → 也能解析', () => {
    const parsed = parseJsonObject('```json\n{"summary":"结论"}\n```');
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual({ summary: '结论' });
  });

  it('📌 JSON 前后有话 → 也能抠出来', () => {
    const parsed = parseJsonObject('好的，结果如下：\n{"summary":"结论"}\n希望有用');
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual({ summary: '结论' });
  });

  it('⚠️ 不是 JSON → 如实说不行（不装成功）', () => {
    expect(parseJsonObject('这是一段散文').ok).toBe(false);
    expect(parseJsonObject('[1,2,3]').ok).toBe(false);
    expect(parseJsonObject('').ok).toBe(false);
  });
});
