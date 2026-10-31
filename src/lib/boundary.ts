/**
 * 服务边界 —— **无鉴权 + 有 shell 权限** 的风险提示
 * （见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **这是替代鉴权的唯一边界**：
 * 没有登录、没有 token、没有权限矩阵 ——
 * 「谁能连上这个服务」就等于「谁能用这个 Agent 执行命令」。
 * 所以监听地址必须默认收紧到回环，改成非回环时要**明确告警**。
 */

/** 回环地址判定（`127.0.0.0/8` · `::1` · `localhost`） */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export interface BoundaryNotice {
  /** 是不是只在本机可访问 */
  loopback: boolean;
  /** 要打印的话（一句话说清风险） */
  message: string;
  /** 是不是危险告警（非回环 = 危险） */
  danger: boolean;
}

/**
 * 生成启动时的边界提示。
 *
 * ⚠️ **非回环时必须说清「谁能用这个 Agent 执行命令」** ——
 * 只写「注意安全」等于没写。
 */
export function describeBoundary(host: string): BoundaryNotice {
  if (isLoopbackHost(host)) {
    return {
      loopback: true,
      danger: false,
      message: `无鉴权 · 仅本机可访问（监听 ${host}）`,
    };
  }
  return {
    loopback: false,
    danger: true,
    message:
      `⚠️ 无鉴权且监听非回环地址（${host}）—— 局域网内任何人都能用本 Agent 执行命令。` +
      '请确认这是你要的，或改回 HOST=127.0.0.1',
  };
}
