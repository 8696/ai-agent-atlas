import { describe, expect, it } from 'vitest';
import {
  assertBrowserUrlAllowed,
  assertBrowserUrlAllowedAsync,
  domainAllowed,
  parseAllowedDomains,
} from '../../src/tools/builtin/browser';

/* eslint-disable @typescript-eslint/require-await --
 * 注入的 `resolve` 是 **异步函数**（签名要求返回 Promise），
 * 它只返回结果、没有 await。
 */

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

describe('浏览器网址校验（解析 DNS）', () => {
  it('⚠️ 域名解析到云元数据地址 → 拦住（白名单空也拦）', async () => {
    await expect(
      assertBrowserUrlAllowedAsync(
        'https://meta-a.example.com/',
        [],
        async () => ['169.254.169.254'],
      ),
    ).rejects.toThrow(/元数据|链路本地/);
  });

  it('⚠️ 白名单非空 + 域名解析到内网 → 拦住', async () => {
    await expect(
      assertBrowserUrlAllowedAsync(
        'https://intranet-b.example.com/',
        ['intranet-b.example.com'],
        async () => ['10.0.0.5'],
      ),
    ).rejects.toThrow(/内网/);
  });

  it('白名单为空 + 解析到回环 → 放行（回环默认放行）', async () => {
    await expect(
      assertBrowserUrlAllowedAsync(
        'https://local-c.example.com/',
        [],
        async () => ['127.0.0.1'],
      ),
    ).resolves.toBeTruthy();
  });

  it('白名单内的域名 + 解析到公网 → 放行', async () => {
    await expect(
      assertBrowserUrlAllowedAsync(
        'https://good-d.example.com/',
        ['good-d.example.com'],
        async () => ['1.1.1.1'],
      ),
    ).resolves.toBeTruthy();
  });
});
