/**
 * CORS 来源白名单 —— **只放本机**（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **为什么不能放开成 `*`**：
 * 这个服务**完全无鉴权**，而且 Agent 有 shell 权限。
 * 放开 CORS = 任意网页都能用用户浏览器里的这个 Agent 发命令。
 */

/** 本机主机名（`localhost` / 回环 IPv4 / 回环 IPv6） */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 这个来源是不是本机 */
export function isLocalOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    // ⚠️ **解析不了 = 不放行** —— 宁可拒掉一个怪来源
    return false;
  }
}

/**
 * 算出该回的 `Access-Control-Allow-Origin`。
 *
 * ⚠️ **同源请求（没有 `Origin` 头）返回空串** —— 那不是跨域，不需要 CORS 头。
 * ⚠️ **非本机来源也返回空串** —— `@koa/cors` 收到假值就不设任何 CORS 头，
 * 浏览器自然拦下来（而不是「回一个错的来源」）。
 */
export function resolveCorsOrigin(ctx: { get: (name: string) => string }): string {
  const origin = ctx.get('Origin');
  if (!origin) return '';
  return isLocalOrigin(origin) ? origin : '';
}
