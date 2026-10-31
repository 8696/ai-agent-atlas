/* eslint-disable @typescript-eslint/require-await --
 * 假的 `resolve` 是 **async 函数** —— 签名要求它返回 Promise，
 * 它只回一个数组、没有 await。
 */

import { describe, expect, it } from 'vitest';
import {
  ModelEndpointError,
  assertModelEndpointAllowed,
  assertModelEndpointReachable,
  classifyEndpointHost,
  isLoopbackUrl,
  modelEndpointProblem,
} from '../../src/lib/security/model-endpoint';

/**
 * 模型端点校验的单元测试（见 [12-a A3](../../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 覆盖：
 * - 回环地址放行（**本地模型**）
 * - 云元数据 / 链路本地地址拦住
 * - 私网自建放行（但分类是 private）
 * - 协议不对拦住
 * - DNS 被劫持到元数据地址时拦住
 * - DNS 解析失败放过（**请求本身会报错**）
 */

describe('模型端点分类', () => {
  it('回环地址 → loopback（本地模型要放行）', () => {
    expect(classifyEndpointHost('127.0.0.1')).toBe('loopback');
    expect(classifyEndpointHost('127.0.0.53')).toBe('loopback');
    expect(classifyEndpointHost('::1')).toBe('loopback');
  });

  it('⚠️ 云元数据地址 → blocked', () => {
    expect(classifyEndpointHost('169.254.169.254')).toBe('blocked');
    expect(classifyEndpointHost('169.254.170.2')).toBe('blocked');
    expect(classifyEndpointHost('100.100.100.200')).toBe('blocked');
    expect(classifyEndpointHost('metadata.google.internal')).toBe('blocked');
  });

  it('⚠️ 链路本地 / 本网络 / 组播 → blocked', () => {
    expect(classifyEndpointHost('169.254.1.1')).toBe('blocked');
    expect(classifyEndpointHost('0.0.0.0')).toBe('blocked');
    expect(classifyEndpointHost('224.0.0.1')).toBe('blocked');
    expect(classifyEndpointHost('fe80::1')).toBe('blocked');
  });

  it('私网自建 → private（放行，但要知道自己落在私网）', () => {
    expect(classifyEndpointHost('192.168.1.10')).toBe('private');
    expect(classifyEndpointHost('10.0.0.5')).toBe('private');
    expect(classifyEndpointHost('172.16.0.1')).toBe('private');
  });

  it('公网 → public', () => {
    expect(classifyEndpointHost('open.bigmodel.cn')).toBe('public');
    expect(classifyEndpointHost('8.8.8.8')).toBe('public');
  });
});

describe('模型端点校验（启动时 · 静态）', () => {
  it('回环地址 → 放行', () => {
    expect(() => assertModelEndpointAllowed('http://127.0.0.1:11434/v1')).not.toThrow();
  });

  it('⚠️ 元数据地址 → 报错', () => {
    expect(() => assertModelEndpointAllowed('http://169.254.169.254/')).toThrow(ModelEndpointError);
  });

  it('⚠️ 协议不对 → 报错', () => {
    expect(() => assertModelEndpointAllowed('file:///etc/passwd')).toThrow(ModelEndpointError);
    expect(() => assertModelEndpointAllowed('ftp://example.com')).toThrow(ModelEndpointError);
  });

  it('⚠️ URL 解析不了 → 报错', () => {
    expect(() => assertModelEndpointAllowed('不是网址')).toThrow(ModelEndpointError);
  });

  it('问题描述能直接拼进启动错误信息', () => {
    expect(modelEndpointProblem('http://169.254.169.254/')).not.toBe('');
    expect(modelEndpointProblem('http://127.0.0.1:11434/v1')).toBe('');
    expect(modelEndpointProblem(undefined)).toBe('');
  });
});

describe('模型端点校验（调用前 · 带 DNS）', () => {
  it('⚠️ 域名被劫持到元数据地址 → 拦住', async () => {
    await expect(
      assertModelEndpointReachable('https://model.example.com/v1', {
        resolve: async () => ['169.254.169.254'],
      }),
    ).rejects.toThrow(ModelEndpointError);
  });

  it('域名解析到公网 → 放行', async () => {
    await expect(
      assertModelEndpointReachable('https://model.example.com/v1', {
        resolve: async () => ['203.0.113.10'],
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('DNS 解析失败 → 放过（请求本身会给出更准的错误）', async () => {
    await expect(
      assertModelEndpointReachable('https://model.example.com/v1', {
        resolve: async () => {
          throw new Error('DNS 挂了');
        },
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('IP 字面量不查 DNS', async () => {
    let resolved = false;
    await assertModelEndpointReachable('http://127.0.0.1:11434/v1', {
      resolve: async () => {
        resolved = true;
        return ['127.0.0.1'];
      },
    });
    expect(resolved).toBe(false);
  });
});

describe('本地端点判定（免 API Key 用）', () => {
  it('回环 → 是本地端点', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1234/v1')).toBe(true);
  });

  it('公网 / 私网 → 不是本地端点', () => {
    expect(isLoopbackUrl('https://open.bigmodel.cn/api/anthropic')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.10:8000/v1')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});
