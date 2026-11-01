import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

/**
 * 出网校验 —— **HTTP 类工具的第二道门**（见 [10 §10.5](../../docs/10-安全方案.md)）。
 *
 * ```
 * http_request：
 *   ① 协议只允许 http / https
 *   ② 解析目标域名 → IP
 *   ③ 判 IP 是否属私网 / 回环 / 链路本地 / 云元数据
 *   ④ 请求（带超时）—— ⚠️ **连到第 ② 步解析出来的那个 IP**
 *   ⑤ 遇到重定向 → 对新地址回到 ②（逐跳校验）
 * ```
 *
 * ⚠️ **只校验第一跳等于没校验** —— 换个 `Location` 就出去了。
 *
 * ⚠️ **校验完还不够，得把 IP 钉住**（DNS rebinding）——
 *   攻击者控制 DNS：第一次解析给公网 IP（校验通过），
 *   第二次解析给 `127.0.0.1`（请求真的连到本机）。
 *   所以这里**自己解析 DNS**，再把连接**钉到那个已校验的 IP**
 *   （`lookup` 回调只吐已校验的地址）——
 *   ⚠️ **TLS 仍然按域名校验证书**（`servername` 走原主机名），
 *   钉 IP 不影响 HTTPS 的正确性。
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
  const target = await resolveTarget(rawUrl, options);
  return target.url;
}

/** 一次校验的结果（**URL + 已校验的 IP**） */
export interface EgressTarget {
  /** 目标地址 */
  url: URL;
  /**
   * **已校验过的 IP 列表** —— 请求只连这些地址。
   *
   * ⚠️ **这就是「钉住 IP」** —— 不给 `fetch` 二次解析的机会。
   */
  addresses: string[];
}

/**
 * 校验一个 URL 并**把它解析成已校验的 IP**。
 *
 * ⚠️ **IP 字面量也要过私网判定** —— 直接写 `http://127.0.0.1/` 一样要拦。
 */
export async function resolveTarget(
  rawUrl: string,
  options: EgressOptions,
): Promise<EgressTarget> {
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
    return { url, addresses: [hostname] };
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

  return { url, addresses };
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
 * 一个只吐「已校验 IP」的 DNS 回调 —— **把连接钉住**。
 *
 * ⚠️ **Node 可能要 `all: true` 的数组形式**（`autoSelectFamily`）——
 *    两种都要支持，只给一种会连不上。
 */
function pinnedLookup(
  addresses: string[],
): (
  hostname: string,
  options: unknown,
  callback: (...args: never[]) => void,
) => void {
  const list = addresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((item) => item.family !== 0);
  return (_hostname, options, callback) => {
    const wantsAll =
      typeof options === 'object' &&
      options !== null &&
      (options as { all?: unknown }).all === true;
    if (wantsAll) {
      (callback as unknown as (err: Error | null, addrs: typeof list) => void)(null, list);
      return;
    }
    const first = list[0];
    if (!first) {
      (callback as unknown as (err: Error | null) => void)(new Error('没有可用的目标地址'));
      return;
    }
    (
      callback as unknown as (err: Error | null, address: string, family: number) => void
    )(null, first.address, first.family);
  };
}

/** 请求头的键统一小写查（**调用方可能写 `Content-Type`**） */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** 一次请求的结果（**重定向单独拎出来**） */
interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyLength: number;
  truncated: boolean;
  /** 有 `Location` 且是 3xx 时给出（**正文不读**） */
  redirect?: string | undefined;
}

/**
 * 发一次请求（**连到已校验的 IP**）。
 *
 * ⚠️ **不用 `fetch`** —— `fetch` 会自己再解析一次 DNS，
 *    DNS rebinding 就是从那道缝里钻进来的。
 *    这里用 `node:http` / `node:https`，
 *    **用 `lookup` 钩子把解析结果换成已校验的 IP**，
 *    而 `Host` 头与 TLS 的 SNI 仍然走原主机名（证书校验照常生效）。
 */
async function requestOnce(
  target: EgressTarget,
  options: {
    method: string | undefined;
    headers: Record<string, string> | undefined;
    body: string | undefined;
    timeoutMs: number;
    maxBytes: number;
  },
): Promise<RawResponse> {
  const { url, addresses } = target;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  // ⚠️ **IPv6 字面量要去掉方括号** —— `new URL()` 的 hostname 带括号
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  // 📌 **默认收压缩** —— 与 `fetch` 的默认行为一致
  if (!hasHeader(headers, 'accept-encoding')) {
    headers['accept-encoding'] = 'gzip, deflate, br';
  }
  if (options.body !== undefined && !hasHeader(headers, 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(options.body));
  }

  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    // 📌 **用一个盒子装请求** —— 超时的回调要在请求建好之前就存在
    const holder: { req?: http.ClientRequest } = {};
    const timer = setTimeout(() => {
      holder.req?.destroy(new EgressError(`请求超时（${options.timeoutMs}ms）`, 'TIMEOUT'));
    }, options.timeoutMs);
    timer.unref?.();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers,
        // ⚠️ **TLS 的 SNI 与证书校验仍然用主机名** —— 钉 IP 不影响 HTTPS
        ...(isHttps ? { servername: hostname } : {}),
        // 📌 **把连接钉到已校验的 IP** —— 不给二次解析的机会
        lookup: pinnedLookup(addresses),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
        }

        // ⚠️ **重定向的正文不要** —— 释放连接，别占着不放
        const location = responseHeaders['location'];
        if (location && status >= 300 && status < 400) {
          res.resume();
          finish(() =>
            resolve({
              status,
              headers: responseHeaders,
              body: '',
              bodyLength: 0,
              truncated: false,
              redirect: location,
            }),
          );
          return;
        }

        readDecoded(res, options.maxBytes).then(
          (read) =>
            finish(() =>
              resolve({
                status,
                headers: responseHeaders,
                body: read.body,
                bodyLength: read.bodyLength,
                truncated: read.truncated,
              }),
            ),
          (err: unknown) =>
            finish(() => reject(toEgressError(err))),
        );
      },
    );

    holder.req = req;

    req.on('error', (err: unknown) => {
      finish(() => reject(toEgressError(err)));
    });

    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** 任何错误都包成 `EgressError`（**带上错误码**） */
function toEgressError(err: unknown): EgressError {
  if (err instanceof EgressError) return err;
  return new EgressError(
    `请求失败：${err instanceof Error ? err.message : String(err)}`,
    'REQUEST_FAILED',
  );
}

/**
 * 读正文（**最多 `maxBytes` 字节**，**解压后算**）。
 *
 * ⚠️ **边读边限量** —— 整个 body 进内存会被大文件撑爆。
 * ⚠️ **`content-encoding` 要自己解** —— `node:http` 不像 `fetch` 那样自动解压。
 */
async function readDecoded(
  res: http.IncomingMessage,
  maxBytes: number,
): Promise<{ body: string; bodyLength: number; truncated: boolean }> {
  const encoding = (res.headers['content-encoding'] ?? '').toLowerCase().trim();
  let stream: AsyncIterable<Buffer | Uint8Array | string> = res;
  if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
  else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
  else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

  const chunks: Buffer[] = [];
  let bodyLength = 0;
  let truncated = false;

  try {
    for await (const chunk of stream) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      bodyLength += buffer.length;
      if (bodyLength > maxBytes) {
        const keep = Math.max(0, maxBytes - (bodyLength - buffer.length));
        chunks.push(buffer.subarray(0, keep));
        truncated = true;
        res.destroy();
        break;
      }
      chunks.push(buffer);
    }
  } catch (err) {
    throw new EgressError(
      `读响应失败：${err instanceof Error ? err.message : String(err)}`,
      'REQUEST_FAILED',
    );
  }

  return {
    body: Buffer.concat(chunks).toString('utf8'),
    bodyLength,
    truncated,
  };
}

/**
 * 发一个「校验过每一跳」的 HTTP 请求。
 *
 * ⚠️ **重定向逐跳校验** —— 每跳都回到 `resolveTarget()`。
 * ⚠️ **每一跳都重新钉 IP** —— 跳到新域名就重新解析、重新校验、重新钉住。
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions,
): Promise<GuardedResponse> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = await resolveTarget(current, options);
    const response = await requestOnce(target, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });

    // ⚠️ **重定向 → 回到校验**（连到新地址就重新解析、重新判、重新钉）
    if (response.redirect) {
      current = new URL(response.redirect, target.url).toString();
      continue;
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      bodyLength: response.bodyLength,
      truncated: response.truncated,
      finalUrl: target.url.toString(),
    };
  }

  throw new EgressError(`重定向超过 ${MAX_REDIRECTS} 跳`, 'TOO_MANY_REDIRECTS');
}
