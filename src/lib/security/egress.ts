import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 出网校验 —— **HTTP 类工具的第二道门**（见 [10 §10.5](../../docs/10-安全方案.md)）。
 *
 * ```
 * http_request：
 *   ① 协议只允许 http / https
 *   ② 解析目标域名 → IP
 *   ③ 判 IP 是否属私网 / 回环 / 链路本地 / 云元数据
 *   ④ 请求（带超时）
 *   ⑤ 遇到重定向 → 对新地址回到 ②（逐跳校验）
 * ```
 *
 * ⚠️ **只校验第一跳等于没校验** —— 换个 `Location` 就出去了。
 */

/** 出网被拦 */
export class EgressError extends Error {
  readonly code: string;

  constructor(message: string, code = 'EGRESS_BLOCKED') {
    super(message);
    this.name = 'EgressError';
    this.code = code;
  }
}

/** 重定向最多跟几跳 */
export const MAX_REDIRECTS = 5;

/** 云元数据主机名（**DNS 层面直接拒**） */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/**
 * 判断一个 IPv4 地址是不是「内网地址」。
 *
 * ⚠️ **按段判断，不靠前缀字符串** —— `172.16.0.1` 与 `172.32.0.1` 只差一段。
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 —— 「本网络」
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 回环
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地（含 169.254.169.254 元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && nums[2] === 0) return true; // 192.0.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 运营商级 NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试段
  if (a >= 224) return true; // 组播 + 保留
  return false;
}

/** 判断一个 IPv6 地址是不是「内网地址」 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0] ?? '';
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80')) return true; // fe80::/10 链路本地
  const first = normalized.split(':')[0] ?? '';
  if (/^f[cd]/.test(first)) return true; // fc00::/7 唯一本地
  // IPv4 映射地址（::ffff:127.0.0.1）
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  return false;
}

/** 这个 IP 是不是内网 / 回环 / 元数据地址 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // ⚠️ **认不出来的地址一律当内网** —— 宁可拦住
}

export interface EgressOptions {
  /** 允许指向私网 / 回环（`.env` 的 `ALLOW_PRIVATE_EGRESS`） */
  allowPrivate: boolean;
  /** DNS 解析（**测试可注入**） */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** 默认的 DNS 解析（**取全部地址** —— 一个域名可能有多个 A 记录） */
async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * 校验一个 URL 能不能访问（**只校验，不发请求**）。
 *
 * @throws EgressError 协议不对 / 指向内网 / 主机名是元数据地址
 */
export async function assertEgressAllowed(
  rawUrl: string,
  options: EgressOptions,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressError(`URL 解析不了：${rawUrl}`, 'INVALID_URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressError(
      `只允许 http / https（不支持 ${url.protocol}）`,
      'PROTOCOL_NOT_ALLOWED',
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (METADATA_HOSTNAMES.has(hostname)) {
    throw new EgressError(`拒绝访问云元数据地址（${hostname}）`, 'METADATA_ADDRESS');
  }

  // IP 字面量：不用解析 DNS，直接判
  if (isIP(hostname)) {
    if (!options.allowPrivate && isPrivateAddress(hostname)) {
      throw new EgressError(`拒绝访问内网地址（${hostname}）`, 'PRIVATE_ADDRESS');
    }
    return url;
  }

  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    throw new EgressError(
      `域名解析失败：${hostname}（${err instanceof Error ? err.message : String(err)}）`,
      'DNS_FAILED',
    );
  }
  if (addresses.length === 0) {
    throw new EgressError(`域名解析不出地址：${hostname}`, 'DNS_FAILED');
  }

  if (!options.allowPrivate) {
    const blocked = addresses.filter((ip) => isPrivateAddress(ip));
    if (blocked.length > 0) {
      throw new EgressError(
        `拒绝访问内网地址（${hostname} → ${blocked.join(', ')}）`,
        'PRIVATE_ADDRESS',
      );
    }
  }

  return url;
}

export interface GuardedFetchOptions extends EgressOptions {
  /** 请求超时（毫秒） */
  timeoutMs: number;
  /** 请求体大小上限（字节） */
  maxBytes: number;
  /** 请求头 */
  headers?: Record<string, string> | undefined;
  /** 方法 */
  method?: string | undefined;
  /** 请求体 */
  body?: string | undefined;
}

export interface GuardedResponse {
  status: number;
  headers: Record<string, string>;
  /** 正文（**已按上限截断**） */
  body: string;
  /** 正文真实长度 */
  bodyLength: number;
  /** 被截断了 */
  truncated: boolean;
  /** 最终落到的 URL（跟了几跳重定向） */
  finalUrl: string;
}

/**
 * 发一个「校验过每一跳」的 HTTP 请求。
 *
 * ⚠️ **重定向逐跳校验** —— 每跳都回到 `assertEgressAllowed`。
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions,
): Promise<GuardedResponse> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertEgressAllowed(current, options);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body ? { body: options.body } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      clearTimeout(timer);
      throw new EgressError(
        controller.signal.aborted ? `请求超时（${options.timeoutMs}ms）` : `请求失败：${reason}`,
        controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED',
      );
    }

    try {
      const location = response.headers.get('location');
      if (location && response.status >= 300 && response.status < 400) {
        // ⚠️ **重定向的正文不要** —— 释放连接，别占着不放
        await response.body?.cancel();
        current = new URL(location, url).toString();
        continue;
      }

      // ⚠️ **边读边限量** —— 整个 body 进内存会被大文件撑爆
      const { body, bodyLength, truncated } = await readBounded(response, options.maxBytes);

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        headers,
        body,
        bodyLength,
        truncated,
        finalUrl: url.toString(),
      };
    } finally {
      // ⚠️ **读完正文才清超时** —— 慢速的正文也能被杀掉
      clearTimeout(timer);
    }
  }

  throw new EgressError(`重定向超过 ${MAX_REDIRECTS} 跳`, 'TOO_MANY_REDIRECTS');
}

/**
 * 读正文（**最多 `maxBytes` 字节**）。
 *
 * ⚠️ **不是 `arrayBuffer()`** —— 那会把整个 body 读进内存，
 * 一个 1GB 的下载就能把进程撑爆。
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; bodyLength: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { body: '', bodyLength: 0, truncated: false };

  const decoder = new TextDecoder();
  let body = '';
  let bodyLength = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bodyLength += value.byteLength;
    if (bodyLength > maxBytes) {
      truncated = true;
      const keep = Math.max(0, maxBytes - (bodyLength - value.byteLength));
      body += decoder.decode(value.subarray(0, keep), { stream: true });
      await reader.cancel();
      break;
    }
    body += decoder.decode(value, { stream: true });
  }

  return { body, bodyLength, truncated };
}
