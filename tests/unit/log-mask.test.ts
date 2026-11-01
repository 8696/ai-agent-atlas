import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../src/logger';
import { registerSecret } from '../../src/lib/errors';

/**
 * 日志打码的单元测试（见 [12-e E4](../docs/12-e-需求-观测安全与验收.md)）。
 *
 * ⚠️ **之前日志完全不打码** —— 供应商 SDK 把原始报错（带着请求头）塞进 `err`，
 * 密钥就跟着进日志了。流水与审计有各自的打码，日志这条是漏的。
 */

/** 收集日志输出（**写流是异步的 —— 断言前要等一拍**） */
function capture(): { stream: Writable; text: () => string; flush: () => Promise<void> } {
  let buffer = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    text: () => buffer,
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

describe('日志打码', () => {
  it('📌 字符串参数里的密钥 → 打码', async () => {
    const { stream, text, flush } = capture();
    const log = createLogger({ destination: stream });
    log.info('带上密钥 sk-abcdef123456 的消息');
    await flush();
    expect(text()).not.toContain('sk-abcdef123456');
    expect(text()).toContain('***');
  });

  it('📌 对象里的 `apiKey` 字段 → 打码', async () => {
    const { stream, text, flush } = capture();
    const log = createLogger({ destination: stream });
    log.info({ apiKey: 'super-secret-value' }, '带密钥的消息');
    await flush();
    expect(text()).not.toContain('super-secret-value');
  });

  it('📌 `err` 里的密钥 → 打码（**且错误信息不能整个消失**）', async () => {
    const { stream, text, flush } = capture();
    const log = createLogger({ destination: stream });
    log.error({ err: new Error('请求失败：Authorization: Bearer tok-abcdef123456') }, '供应商报错');
    await flush();
    expect(text()).not.toContain('tok-abcdef123456');
    // 📌 **Error 的 message / stack 是不可枚举属性** —— 打码不能把它抹成 `{}`
    expect(text()).toContain('请求失败');
  });

  it('📌 登记过的精确密钥 → 打码（**供应商私有形态**）', async () => {
    registerSecret('abc123def456.zhipu');
    const { stream, text, flush } = capture();
    const log = createLogger({ destination: stream });
    log.info('模型返回了 abc123def456.zhipu 这个 key');
    await flush();
    expect(text()).not.toContain('abc123def456.zhipu');
  });

  it('📌 普通日志不受影响', async () => {
    const { stream, text, flush } = capture();
    const log = createLogger({ destination: stream });
    log.info({ tool: 'read_file', path: 'notes.md' }, '读了文件');
    await flush();
    expect(text()).toContain('read_file');
    expect(text()).toContain('notes.md');
  });
});
