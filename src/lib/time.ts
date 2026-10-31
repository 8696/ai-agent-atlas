/**
 * 时间工具 —— **库里一律存 UTC 墙钟**（见 [05-a §5.3](../docs/05-a-数据模型-sqlite.md)）。
 *
 * ⚠️ **为什么不用 `new Date()` 直接塞给驱动**：
 * 不同驱动渲染成本地墙钟，两边对不上 ——
 * 症状是「今日对话数在每天的前 8 小时恒为 0」。
 * 所以入库前一律转成 `YYYY-MM-DD HH:mm:ss.SSS` 的 UTC 字符串。
 *
 * ⚠️ **字符串定宽 → 字典序 = 时间序**：
 * `ORDER BY created_at DESC` 直接可用，索引也吃得到。
 */

/** 补零 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Date → UTC 墙钟字符串（`YYYY-MM-DD HH:mm:ss.SSS`） */
export function toUtcString(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.` +
    `${pad(date.getUTCMilliseconds(), 3)}`
  );
}

/**
 * 进程内单调递增的时钟 —— 同一毫秒里多次调用会各差 1 毫秒。
 *
 * ⚠️ **为什么需要它**：消息表没有自增序号列，
 * 同一毫秒插入的多条消息 `created_at` 会相同 → 排序不稳 → 「按时间倒序取历史」会乱序。
 * 让时间戳严格递增就解决了，**不用改表结构**。
 */
let lastTick = 0;

/** 现在（UTC 墙钟字符串，进程内单调递增） */
export function utcNow(): string {
  const now = Date.now();
  const tick = now > lastTick ? now : lastTick + 1;
  lastTick = tick;
  return toUtcString(new Date(tick));
}

/** UTC 墙钟字符串 → ISO 字符串（给前端） */
export function utcToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** 任意可解析的时间 → UTC 墙钟字符串 */
export function toUtcFrom(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return toUtcString(Number.isNaN(date.getTime()) ? new Date() : date);
}

/** N 天前的 UTC 墙钟字符串（保留期清理用） */
export function utcDaysAgo(days: number): string {
  return toUtcString(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}
