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

/**
 * 某时区此刻的「墙上时间」各字段。
 *
 * ⚠️ **库里存 UTC，分桶按本地时区** —— 两套时间口径混用时，
 * 症状是「每天的前 8 小时恒为 0」（见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）。
 */
function wallClockParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts['year'] ?? 0),
    month: Number(parts['month'] ?? 1),
    day: Number(parts['day'] ?? 1),
    // ⚠️ **hour 可能是 `24`** —— `hour12: false` 在午夜会给出 24
    hour: Number(parts['hour'] ?? 0) % 24,
    minute: Number(parts['minute'] ?? 0),
    second: Number(parts['second'] ?? 0),
  };
}

/**
 * 本月起点（**UTC 墙钟字符串**）—— 按 `timeZone` 分桶。
 *
 * 📌 **月度预算按这个切** —— 「本月用量」必须是本地自然月，
 * 不是 UTC 自然月（否则月初那几小时会算到上个月）。
 */
export function monthStartUtcString(timeZone: string, now: Date = new Date()): string {
  const parts = wallClockParts(now, timeZone);
  // ⚠️ **day 必须是 1** —— 这是「本月起点」，不是「今天零点」
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, 1, 0, 0, 0);
  const nowAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offset = nowAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return toUtcString(new Date(wallAsUtc - offset));
}

/** 本地日期（`YYYY-MM-DD`，按 `timeZone`） */
export function localDateString(timeZone: string, now: Date = new Date()): string {
  const parts = wallClockParts(now, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}
