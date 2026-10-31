import { describe, expect, it } from 'vitest';
import { deriveTitle, DEFAULT_TITLE, TITLE_MAX_LENGTH } from '../../src/lib/session-title';
import { describeBoundary, isLoopbackHost } from '../../src/lib/boundary';
import { isLocalOrigin, resolveCorsOrigin } from '../../src/lib/cors';

/**
 * 纯函数单元测试 —— **不碰配置、不联网、不碰数据库**。
 *
 * 覆盖：会话标题生成 · 服务边界判定 · CORS 来源白名单。
 */

describe('会话标题（首条用户消息截断）', () => {
  it('短标题原样保留', () => {
    expect(deriveTitle('你好')).toBe('你好');
  });

  it('⚠️ 超长截断到 30 字（省略号算在里面）', () => {
    const title = deriveTitle('一'.repeat(50));
    expect(title.length).toBe(TITLE_MAX_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('换行与连续空白压成一个空格', () => {
    expect(deriveTitle('  帮我\n查一下   这件事  ')).toBe('帮我 查一下 这件事');
  });

  it('空消息给默认标题', () => {
    expect(deriveTitle('   ')).toBe(DEFAULT_TITLE);
  });
});

describe('服务边界（无鉴权的唯一防线）', () => {
  it('回环地址算本机', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.5')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('⚠️ 非回环不算本机（0.0.0.0 会把服务开到局域网）', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });

  it('回环 → 普通提示，不告警', () => {
    const notice = describeBoundary('127.0.0.1');
    expect(notice.danger).toBe(false);
    expect(notice.loopback).toBe(true);
    expect(notice.message).toContain('仅本机可访问');
  });

  it('⚠️ 非回环 → 告警要说清「谁能执行命令」', () => {
    const notice = describeBoundary('0.0.0.0');
    expect(notice.danger).toBe(true);
    expect(notice.message).toContain('无鉴权');
    expect(notice.message).toContain('执行命令');
    expect(notice.message).toContain('127.0.0.1');
  });
});

describe('CORS 来源白名单', () => {
  it('本机来源放行', () => {
    expect(isLocalOrigin('http://localhost:5180')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:5180')).toBe(true);
  });

  it('⚠️ 局域网来源不放行（服务无鉴权且有 shell 权限）', () => {
    expect(isLocalOrigin('http://192.168.1.10:5180')).toBe(false);
    expect(isLocalOrigin('http://evil.example.com')).toBe(false);
    expect(isLocalOrigin('not-a-url')).toBe(false);
  });

  it('同源请求（没有 Origin 头）不设 CORS 头', () => {
    expect(resolveCorsOrigin({ get: () => '' })).toBe('');
  });

  it('本机来源原样回传', () => {
    expect(resolveCorsOrigin({ get: () => 'http://localhost:5180' })).toBe('http://localhost:5180');
  });

  it('⚠️ 非本机来源回空（浏览器会拦下来）', () => {
    expect(resolveCorsOrigin({ get: () => 'http://evil.example.com' })).toBe('');
  });
});
