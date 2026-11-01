import type { PendingConfirm } from '../agent/state.js';

/**
 * 待确认的登记处 —— **进程内**（**确认卡片挂起时，用户点按钮要用它唤醒等待**）。
 *
 * ⚠️ **进程重启后这里会空** —— 但**图状态在检查点里**，
 * 所以重启后照样能恢复（见 [12-b B6](../docs/12-b-需求-对话与编排.md)）。
 */

/** 用户的决定 */
export interface PendingDecision {
  /** 批准还是取消 */
  approved: boolean;
  /** 入参指纹 —— ⚠️ **参数变了就不能沿用旧的批准** */
  fingerprint?: string | undefined;
  /**
   * ⚠️ **「本轮剩下的都批准」** —— 用户点的是那个按钮。
   *
   * 📌 **只在这一轮有效** —— 标志记在图状态里，
   *    下一轮的 `prepare` 会把它清掉。
   */
  approveAll?: boolean | undefined;
}

interface PendingEntry {
  payload: PendingConfirm;
  resolve: (decision: PendingDecision) => void;
  timer: NodeJS.Timeout | undefined;
}

/** 待确认表（**会话 id → 条目**） */
const pending = new Map<string, PendingEntry>();

/**
 * 等一个决定（**挂起到超时**）。
 *
 * @param sessionId 会话 id
 * @param payload 待确认的内容（**给前端看**）
 * @param timeoutMs 等多久（**默认 10 分钟** —— 再久用户也忘了在等什么）
 */
export function waitForDecision(
  sessionId: string,
  payload: PendingConfirm,
  timeoutMs = 10 * 60 * 1000,
): Promise<PendingDecision> {
  return new Promise<PendingDecision>((resolve) => {
    const entry: PendingEntry = {
      payload,
      resolve: (decision) => {
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(sessionId);
        resolve(decision);
      },
      timer: undefined,
    };
    entry.timer = setTimeout(() => {
      pending.delete(sessionId);
      // ⚠️ **超时按「取消」处理** —— 不能无限期挂着
      resolve({ approved: false });
    }, timeoutMs);
    // ⚠️ **别让定时器拖住进程退出**
    entry.timer.unref?.();
    pending.set(sessionId, entry);
  });
}

/** 用户点了批准 / 取消（**返回有没有等到人**） */
export function resolvePendingDecision(
  sessionId: string,
  decision: PendingDecision,
): boolean {
  const entry = pending.get(sessionId);
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

/** 当前挂起的确认（**给「重启后恢复」那条路用**） */
export function getPending(sessionId: string): PendingConfirm | undefined {
  return pending.get(sessionId)?.payload;
}

/** 清掉挂起（**会话被删时用**） */
export function clearPending(sessionId: string): void {
  const entry = pending.get(sessionId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(sessionId);
  // ⚠️ **把等待的那个请求叫醒** —— 会话没了，不能让它一直挂着
  entry.resolve({ approved: false });
}
