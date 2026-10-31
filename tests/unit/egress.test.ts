import { describe, expect, it } from 'vitest';
import {
  EgressError,
  assertEgressAllowed,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
} from '../../src/lib/security/egress';

/* eslint-disable @typescript-eslint/require-await --
 * 注入的 `resolve` 是 **异步函数**（签名要求返回 Promise），
 * 它只返回结果、没有 await。
 */

/**
 * 出网校验的单元测试 —— **纯本地，不发请求**。
 *
 * 覆盖：私网判定 · 协议白名单 · 云元数据地址 · DNS 解析后的判定。
 */

describe('私网地址判定', () => {
  it('IPv4 私网段全都要拦', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
    ]) {
      expect(isPrivateIPv4(ip), ip).toBe(true);
    }
  });

  it('公网 IPv4 不拦', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '172.15.0.1', '223.5.5.5']) {
      expect(isPrivateIPv4(ip), ip).toBe(false);
    }
  });

  it('IPv6 回环 / 链路本地 / ULA 要拦', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('fd00::1')).toBe(true);
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });

  it('IPv4 映射的 IPv6 也算私网', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('认不出来的地址 → 当私网（宁可拦住）', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('出网校验', () => {
  it('⚠️ 非 http/https 协议被拒', async () => {
    await expect(
      assertEgressAllowed('file:///etc/passwd', { allowPrivate: false }),
    ).rejects.toThrow(EgressError);
    await expect(
      assertEgressAllowed('file:///etc/passwd', { allowPrivate: false }),
    ).rejects.toThrow(/只允许 http/);
  });

  it('⚠️ 元数据地址被拒', async () => {
    await expect(
      assertEgressAllowed('http://169.254.169.254/latest/meta-data/', {
        allowPrivate: false,
      }),
    ).rejects.toThrow(/内网地址/);
    await expect(
      assertEgressAllowed('http://metadata.google.internal/', { allowPrivate: false }),
    ).rejects.toThrow(/元数据/);
  });

  it('⚠️ 域名解析到私网 → 被拒', async () => {
    await expect(
      assertEgressAllowed('http://evil.example.com/', {
        allowPrivate: false,
        resolve: async () => ['127.0.0.1'],
      }),
    ).rejects.toThrow(/内网地址/);
  });

  it('域名解析到公网 → 放行', async () => {
    const url = await assertEgressAllowed('https://example.com/path', {
      allowPrivate: false,
      resolve: async () => ['1.1.1.1'],
    });
    expect(url.toString()).toBe('https://example.com/path');
  });

  it('⚠️ 开了放行开关 → 私网也放行', async () => {
    const url = await assertEgressAllowed('http://127.0.0.1:8080/', { allowPrivate: true });
    expect(url.hostname).toBe('127.0.0.1');
  });

  it('⚠️ 域名解析失败 → 明确报错', async () => {
    await expect(
      assertEgressAllowed('https://nope.invalid/', {
        allowPrivate: false,
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toThrow(/域名解析失败/);
  });
});
