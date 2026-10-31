/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '../../src/services/model';

/**
 * 模型降级与故障转移的单元测试（见 [12-a A3](../../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 覆盖：
 * - 主模型正常 → 不切
 * - 主模型报错（还没吐内容）→ 切备用
 * - ⚠️ **已经吐过内容再报错 → 不切**（用户会看到两段拼接的答案）
 * - 供应商不支持思考 → 关掉思考重试
 * - 备用也没有 → 错误照抛
 */

/** 每个模型一次调用的行为 */
type Behaviour =
  | { kind: 'ok'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'error-after-text'; message: string; text: string };

/** 模型名 → 行为 */
const behaviours = new Map<string, Behaviour>();

/** 每次建模型记一笔（**用来验降级顺序**） */
const built: Array<{ model: string; budget: number }> = [];

vi.mock('../../src/services/model', () => ({
  createChatModel: (model: ResolvedModel) => {
    built.push({ model: model.name, budget: model.thinkingBudget });
    const behaviour = behaviours.get(model.name) ?? { kind: 'ok' as const, text: '没事' };
    const chat = {
      bindTools: () => chat,
      stream: async function* () {
        if (behaviour.kind === 'error') throw new Error(behaviour.message);
        if (behaviour.kind === 'error-after-text') {
          yield { text: behaviour.text };
          throw new Error(behaviour.message);
        }
        yield { text: behaviour.text };
      },
      invoke: async () => ({ content: '' }),
    };
    return Promise.resolve(chat);
  },
  resolveModel: () => undefined,
  resolveFallback: () => undefined,
}));

const { streamChatModel } = await import('../../src/agent/model-stream');

/** 造一个模型 */
function model(name: string, thinkingBudget = 0): ResolvedModel {
  return {
    name,
    baseUrl: 'https://example.com',
    apiKey: 'k',
    modelId: name,
    maxTokens: 1024,
    temperature: 1,
    thinkingBudget,
  };
}

/** 把流跑完 */
async function drain(
  primary: ResolvedModel,
  fallback: ResolvedModel | undefined,
  thinkingBudget = 0,
): Promise<{ texts: string[]; strategies: string[]; error: unknown }> {
  const texts: string[] = [];
  const strategies: string[] = [];
  let error: unknown = undefined;
  try {
    for await (const item of streamChatModel({
      primary,
      fallback,
      thinkingBudget,
      messages: [],
      tools: [],
    })) {
      const piece = item.chunk as { text?: string };
      if (piece.text) texts.push(piece.text);
      strategies.push(item.strategy);
    }
  } catch (err) {
    error = err;
  }
  return { texts, strategies, error };
}

beforeEach(() => {
  behaviours.clear();
  built.length = 0;
});

describe('模型降级与故障转移', () => {
  it('主模型正常 → 不切备用', async () => {
    behaviours.set('主', { kind: 'ok', text: '主模型的话' });
    behaviours.set('备', { kind: 'ok', text: '备用模型的话' });

    const result = await drain(model('主'), model('备'));

    expect(result.texts.join('')).toBe('主模型的话');
    expect(result.error).toBeUndefined();
    expect(built.map((item) => item.model)).toEqual(['主']);
  });

  it('⚠️ 主模型报错（还没吐内容）→ 自动切备用', async () => {
    behaviours.set('主', { kind: 'error', message: '500 Internal Server Error' });
    behaviours.set('备', { kind: 'ok', text: '备用模型的话' });

    const result = await drain(model('主'), model('备'));

    expect(result.error).toBeUndefined();
    expect(result.texts.join('')).toBe('备用模型的话');
    expect(built.map((item) => item.model)).toEqual(['主', '备']);
  });

  it('⚠️ 已经吐过内容再报错 → 不切备用（错误照抛）', async () => {
    behaviours.set('主', { kind: 'error-after-text', message: '500', text: '说到一半' });
    behaviours.set('备', { kind: 'ok', text: '备用模型的话' });

    const result = await drain(model('主'), model('备'));

    expect(result.error).toBeInstanceOf(Error);
    expect(result.texts.join('')).toBe('说到一半');
    // 📌 **备用根本没被调用**
    expect(built.map((item) => item.model)).toEqual(['主']);
  });

  it('⚠️ 供应商不支持思考 → 关掉思考重试（同一个模型）', async () => {
    behaviours.set('主', { kind: 'error', message: '400 thinking is not supported' });
    behaviours.set('备', { kind: 'ok', text: '备用模型的话' });

    const result = await drain(model('主', 1024), model('备'), 1024);

       expect(result.error).toBeUndefined();
    // 📌 **先原样重试（带思考），再关掉思考重试，还是不行才切备用**
    expect(built).toEqual([
      { model: '主', budget: 1024 },
      { model: '主', budget: 0 },
      { model: '备', budget: 0 },
    ]);
    expect(result.texts.join('')).toBe('备用模型的话');
  });

  it('没有备用模型 → 错误照抛', async () => {
    behaviours.set('主', { kind: 'error', message: '500' });

    const result = await drain(model('主'), undefined);

    expect(result.error).toBeInstanceOf(Error);
    expect(built.map((item) => item.model)).toEqual(['主']);
  });

  it('⚠️ 思考预算本来就是 0 → 不做「关思考」重试，直接切备用', async () => {
    behaviours.set('主', { kind: 'error', message: '500' });
    behaviours.set('备', { kind: 'ok', text: '备用模型的话' });

    const result = await drain(model('主'), model('备'), 0);

    expect(result.error).toBeUndefined();
    expect(built.map((item) => item.model)).toEqual(['主', '备']);
  });
});
