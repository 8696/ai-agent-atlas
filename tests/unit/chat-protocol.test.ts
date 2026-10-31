import { describe, expect, it } from 'vitest';
import { createChatEventStream, type ChatEvent } from '../../src/agent/events';
import { registerSecret, sanitizeMessage } from '../../src/lib/errors';
import { extractText, toLangChainMessages } from '../../src/services/chat-messages';
import { renderTemplate } from '../../src/services/prompt';

/**
 * 对话竖切的单元测试 —— **纯函数，不碰配置、不联网**。
 *
 * 覆盖：消息形状转换 · 提示词占位符 · 错误打码 · 协议翻译。
 */

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('UI 消息 → LangChain 消息', () => {
  it('只取文本 part，其他 part 忽略', () => {
    const text = extractText([
      { type: 'text', text: '你好' },
      { type: 'file', text: '忽略我' },
      { type: 'text', text: '世界' },
    ]);
    expect(text).toBe('你好世界');
  });

  it('角色映射正确', () => {
    const messages = toLangChainMessages([
      { role: 'user', parts: [{ type: 'text', text: '问' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '答' }] },
      { role: 'system', parts: [{ type: 'text', text: '规' }] },
    ]);
    expect(messages.map((m) => m.getType())).toEqual(['human', 'ai', 'system']);
    expect(messages.map((m) => m.content)).toEqual(['问', '答', '规']);
  });
});

describe('提示词占位符', () => {
  it('已识别的被替换', () => {
    expect(renderTemplate('日期 {{date}} 工具 {{tools}}', { date: '2026-10-31', tools: 'x' })).toBe(
      '日期 2026-10-31 工具 x',
    );
  });

  it('⚠️ 未识别的原样保留（不清空用户写的内容）', () => {
    expect(renderTemplate('{{foo}} 与 {{date}}', { date: 'd' })).toBe('{{foo}} 与 d');
  });
});

describe('错误打码', () => {
  it('注册过的密钥不出现在消息里', () => {
    registerSecret('sk-secret-value-123456');
    const message = sanitizeMessage('failed with sk-secret-value-123456');
    expect(message).not.toContain('sk-secret-value-123456');
    expect(message).toContain('***');
  });

  it('疑似密钥也打码', () => {
    expect(sanitizeMessage('api_key: abcdef123456')).toContain('***');
    expect(sanitizeMessage('Authorization: Bearer abcdef123456')).toContain('***');
  });
});

describe('协议翻译（领域事件 → UI Message Stream）', () => {
  it('chunk 顺序符合协议', async () => {
    async function* events(): AsyncGenerator<ChatEvent> {
      yield { type: 'text-delta', delta: '你' };
      yield { type: 'text-delta', delta: '好' };
    }
    const chunks = await collect(createChatEventStream({ events: events() }));
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
  });

  it('⚠️ 没有文本时也不发 text-start / text-end', async () => {
    async function* events(): AsyncGenerator<ChatEvent> {
      // 空流
    }
    const chunks = await collect(createChatEventStream({ events: events() }));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['start', 'start-step', 'finish-step', 'finish']);
  });

  it('文本增量的内容原样透传', async () => {
    async function* events(): AsyncGenerator<ChatEvent> {
      yield { type: 'text-delta', delta: '哈' };
    }
    const chunks = await collect(createChatEventStream({ events: events() }));
    const delta = chunks.find((chunk) => chunk.type === 'text-delta');
    expect(delta && 'delta' in delta ? delta.delta : null).toBe('哈');
  });
});
