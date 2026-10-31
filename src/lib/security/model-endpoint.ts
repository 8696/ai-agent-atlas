import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 模型端点校验 —— **`LLM_BASE_URL` 的 SSRF 闸**（见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ```
 * 启动时：静态校验（协议 + 主机名 / IP 字面量）→ 不合法就启动失败
 * 每次调用前：再加一层 DNS 解析 → 域名被劫持到内网 / 元数据地址也拦住
 * ```
 *
 * ⚠️ **回环地址是例外** —— 本地模型（Ollama / LM Studio / vLLM）就住在
 * `127.0.0.1` 上，那是用户自己的机器，**必须允许**。
 *
 * ⚠️ **和 `lib/security/egress.ts` 的区别** —— 那道闸管的是「模型主动发起的
 * HTTP 请求」，私网一律禁；这道闸管的是「用户自己配的模型服务地址」，
 * 私网自建（NAS 上的推理机）要放行，只把**云元数据地址**这类
 * 「一撞就泄露云凭据」的目标挡住。
 */

/** 端点分类 */
export type EndpointClass =
  /** 回环 —— 用户自己机器上的服务（本地模型） */
  | 'loopback'
  /** 私网 —— 自建服务（NAS / 局域网推理机），放行但告警 */
  | 'private'
  /** 公网 —— 正常情况 */
  | 'public'
  /** 禁止 —— 云元数据 / 链路本地 / 组播 */
  | 'blocked';

/** 端点被拦 */
export class ModelEndpointError extends Error {
  readonly code: string;

  constructor(message: string, code = 'MODEL_ENDPOINT_BLOCKED') {
    super(message);
    this.name = 'ModelEndpointError';
    this.code = code;
  }
}

/** 云元数据主机名（**DNS 层面直接拒**） */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

/** 云元数据 IP（各家的） */
const METADATA_IPS = new Set([
  '169.254.169.254', // AWS / GCP / Azure
  '169.254.170.2', // AWS ECS
  '100.100.100.200', // 阿里云
  'fd00:ec2::254', // AWS IPv6
]);

/** IPv4 → 分段（解析不了就返回 undefined） */
function ipv4Parts(ip: string): number[] | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return nums;
}

/** 判断一个 IPv4 属于哪一类 */
function classifyIPv4(ip: string): EndpointClass {
  if (METADATA_IPS.has(ip)) return 'blocked';
  const nums = ipv4Parts(ip);
  if (!nums) return 'blocked';
  const [a, b] = nums as [number, number, ...number[]];
  if (a === 127) return 'loopback'; // 127/8 回环 —— 本地模型
  if (a === 169 && b === 254) return 'blocked'; // 169.254/16 链路本地（含元数据）
  if (a === 0) return 'blocked'; // 0/8 「本网络」
  if (a === 10) return 'private'; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16/12
  if (a === 192 && b === 168) return 'private'; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64/10 运营商级 NAT
  if (a >= 224) return 'blocked'; // 组播 + 保留
  return 'public';
}

/** 判断一个 IPv6 属于哪一类 */
function classifyIPv6(ip: string): EndpointClass {
  const normalized = ip.toLowerCase().split('%')[0] ?? '';
  if (METADATA_IPS.has(normalized)) return 'blocked';
  if (normalized === '::1' || normalized === '::') return 'loopback';
  if (normalized.startsWith('fe80')) return 'blocked'; // fe80::/10 链路本地
  // IPv4 映射地址（::ffff:127.0.0.1）
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return classifyIPv4(mapped[1]);
  const first = normalized.split(':')[0] ?? '';
  if (/^f[cd]/.test(first)) return 'private'; // fc00::/7 唯一本地
  return 'public';
}

/**
 * 这个主机名 / IP 属于哪一类。
 *
 * ⚠️ **域名一律先当公网** —— 真正的判定在 `assertModelEndpointReachable`
 * 里做（要解析 DNS）。
 */
export function classifyEndpointHost(hostname: string): EndpointClass {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_HOSTNAMES.has(host)) return 'blocked';
  // 📌 **`localhost` 就是回环** —— 本地模型常用它
  if (host === 'localhost') return 'loopback';
  const family = isIP(host);
  if (family === 4) return classifyIPv4(host);
  if (family === 6) return classifyIPv6(host);
  return 'public';
}

/** 是不是本地端点（**回环**）—— 本地模型免 API Key 就靠它 */
export function isLoopbackUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return classifyEndpointHost(url.hostname) === 'loopback';
  } catch {
    return false;
  }
}

/**
 * 静态校验（**启动时用**）—— 协议 + 主机名 / IP 字面量。
 *
 * ⚠️ **不解析 DNS** —— 启动时不该因为网络不通就起不来。
 *
 * @throws ModelEndpointError 协议不对 / 指向被禁的地址
 */
export function assertModelEndpointAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ModelEndpointError(`模型端点 URL 解析不了：${rawUrl}`, 'INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelEndpointError(
      `模型端点只允许 http / https（不支持 ${url.protocol}）`,
      'PROTOCOL_NOT_ALLOWED',
    );
  }
  const kind = classifyEndpointHost(url.hostname);
  if (kind === 'blocked') {
    throw new ModelEndpointError(
      `模型端点「${url.hostname}」被禁 —— 不能指向云元数据 / 链路本地地址`,
      'BLOCKED_ADDRESS',
    );
  }
  return url;
}

/**
 * 静态校验的**问题描述**（**给 `config/schema.ts` 的跨字段校验用**）。
 *
 * 📌 **返回空串 = 没问题** —— 这样启动校验能直接把问题拼进错误信息。
 */
export function modelEndpointProblem(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  try {
    assertModelEndpointAllowed(rawUrl);
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface EndpointResolveOptions {
  /** DNS 解析（**测试可注入**） */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** 默认的 DNS 解析（取全部地址） */
async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * 调用前的完整校验（**静态 + DNS**）。
 *
 * ⚠️ **DNS 解析失败不报错** —— 解析不了只是这次网络有问题，
 * 真正的请求会给出更准确的错误；这里只拦「解析到了危险地址」。
 *
 * @throws ModelEndpointError 指向被禁的地址
 */
export async function assertModelEndpointReachable(
  rawUrl: string,
  options: EndpointResolveOptions = {},
): Promise<URL> {
  const url = assertModelEndpointAllowed(rawUrl);
  const host = url.hostname.toLowerCase();
  if (isIP(host)) return url; // IP 字面量静态判过了

  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    // ⚠️ **解析失败就放过** —— 拦不住不等于有问题，请求本身会报错
    return url;
  }
  for (const address of addresses) {
    if (classifyEndpointHost(address) === 'blocked') {
      throw new ModelEndpointError(
        `模型端点「${host}」解析到了被禁的地址（${address}）—— 不能指向云元数据 / 链路本地地址`,
        'BLOCKED_ADDRESS',
      );
    }
  }
  return url;
}
