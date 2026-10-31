/**
 * 每轮请求的 abort 信号（**按消息 id 登记**）。
 *
 * 📌 **为什么要有这个**：LangGraph 会把信号组合成它自己的
 * `composedAbortSignal` 再发给节点 —— 组合逻辑偶尔对不上，
 * 客户端断开时上游就停不下来（白烧 token）。
 * 这里**把网关自己的信号直接交给节点**，不指望中间层转发。
 */
const signals = new Map<string, AbortSignal>();

/** 登记一轮请求的信号 */
export function registerRequestSignal(messageId: string, signal: AbortSignal): void {
  signals.set(messageId, signal);
}

/** 注销（一轮结束就清掉 —— 不然 map 会越攒越多） */
export function unregisterRequestSignal(messageId: string): void {
  signals.delete(messageId);
}

/** 取一轮请求的信号 */
export function requestSignal(messageId: string | undefined): AbortSignal | undefined {
  return messageId ? signals.get(messageId) : undefined;
}
