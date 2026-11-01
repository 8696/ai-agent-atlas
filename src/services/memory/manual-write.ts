/**
 * 手动写入的记录 —— **用来抑制自动抽取**
 * （见 [12-d D4](../../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **为什么需要** —— 用户说「记住我用 pnpm」时，
 *    主代理会调 `memory` 工具写一条；这一轮结束后的**自动抽取**也会写一条，
 *    两条内容一样、名字可能不同 → 记忆库里多一条重复。
 *
 * ⚠️ **单独一个模块** —— `index.ts` 与 `extract.ts` 都要用它，
 *    放在 `index.ts` 里会形成 `index → extract → index` 的循环依赖。
 */

/** 每个键记的是「最后一次手动写入」的时刻 */
const manualWrites = new Map<string, number>();

/** 没有会话 id 时用的键（**CLI / 定时任务**） */
const GLOBAL_WRITE_KEY = '__global__';

/** 抑制窗口（毫秒） */
const MANUAL_WRITE_TTL_MS = 60_000;

/** 记一笔「这一轮有人手动写过记忆」 */
export function noteManualMemoryWrite(sessionId?: string): void {
  const now = Date.now();
  manualWrites.set(sessionId ?? GLOBAL_WRITE_KEY, now);
  // 📌 **顺手清掉过期的** —— 不然这个 Map 会一直长
  for (const [key, at] of manualWrites) {
    if (now - at > MANUAL_WRITE_TTL_MS * 10) manualWrites.delete(key);
  }
}

/** 这一轮（或刚刚）有没有人手动写过记忆 */
export function recentManualMemoryWrite(
  sessionId?: string,
  withinMs: number = MANUAL_WRITE_TTL_MS,
): boolean {
  const now = Date.now();
  // 📌 **会话自己的记录 + 全局记录都算** ——
  //    没有会话 id 的写入（CLI / 定时任务）会影响所有会话
  for (const key of [sessionId ?? GLOBAL_WRITE_KEY, GLOBAL_WRITE_KEY]) {
    const at = manualWrites.get(key);
    if (at !== undefined && now - at <= withinMs) return true;
  }
  return false;
}

/** 清空记录（**测试用**） */
export function resetManualMemoryWrites(): void {
  manualWrites.clear();
}
