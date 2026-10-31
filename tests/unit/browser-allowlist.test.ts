import { describe, expect, it } from 'vitest';
import {
  assertBrowserUrlAllowed,
  domainAllowed,
  parseAllowedDomains,
} from '../../src/tools/builtin/browser';

/**
 * 浏览器域名白名单的单元测试（见 [12-c C2](../../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 覆盖：
 * - 白名单解析（逗号 / 空格分隔）
 * - `*.example.com` 认「本身」与「子域」
 * - 白名单外的域名被拦
 * - 云元数据 / 链路本地地址一律拦
 * - 协议不对拦
 */

describe('域名白名单', () => {
  it('逗号 / 空格分隔都能解析', () => {
    expect(parseAllowedDomains('a.com, b.com')).toEqual(['a.com', 'b.com']);
    expect(parseAllowedDomains('a.com b.com')).toEqual(['a.com', 'b.com']);
    expect(parseAllowedDomains('a.com，b.com')).toEqual(['a.com', 'b.com']);
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains('  ')).toEqual([]);
  });

  it('精确匹配', () => {
    expect(domainAllowed('example.com', ['example.com'])).toBe(true);
    expect(domainAllowed('evil.com', ['example.com'])).toBe(false);
  });

  it('⚠️ 通配符认「本身」与「子域」，但不认「长得像的」', () => {
    expect(domainAllowed('example.com', ['*.example.com'])).toBe(true);
    expect(domainAllowed('api.example.com', ['*.example.com'])).toBe(true);
    expect(domainAllowed('notexample.com', ['*.example.com'])).toBe(false);
  });
});

describe('浏览器网址校验', () => {
  it('白名单为空 → 公网域名放行', () => {
    expect(() => assertBrowserUrlAllowed('https://example.com/', [])).not.toThrow();
  });

  it('⚠️ 白名单外的域名 → 拦住', () => {
    expect(() => assertBrowserUrlAllowed('https://evil.com/', ['example.com'])).toThrow(
      /不在白名单里/,
    );
  });

  it('白名单内的域名 → 放行', () => {
    expect(() => assertBrowserUrlAllowed('https://example.com/', ['example.com'])).not.toThrow();
  });

  it('⚠️ 精确匹配不含子域（要用 `*.example.com` 才放行子域）', () => {
    expect(() => assertBrowserUrlAllowed('https://api.example.com/', ['example.com'])).toThrow(
      /不在白名单里/,
    );
    expect(() =>
      assertBrowserUrlAllowed('https://api.example.com/', ['*.example.com']),
    ).not.toThrow();
  });

  it('⚠️ 云元数据地址 → 拦住（哪怕在白名单里）', () => {
    expect(() =>
      assertBrowserUrlAllowed('http://169.254.169.254/latest/meta-data/', ['169.254.169.254']),
    ).toThrow(/元数据|链路本地/);
  });

  it('⚠️ 协议不对 → 拦住', () => {
    expect(() => assertBrowserUrlAllowed('file:///etc/passwd', [])).toThrow(/http/);
  });
});
