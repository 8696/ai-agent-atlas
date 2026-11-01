/**
 * 时间格式化 —— **显示层按浏览器时区转**（见 [05-a §5.3](../../docs/05-a-数据模型-sqlite.md)）。
 *
 * ⚠️ **库里存的是 UTC 墙钟** —— 前端拿到的是 ISO 字符串，这里直接按本地时区显示。
 */

/** 相对时间（`刚刚` · `3 分钟前` · `昨天 14:20` · `10-28`） */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';

  const now = new Date();
  const diffMs = now.getTime() - time.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return '刚刚';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < day && isSameDay(time, now)) return `${Math.floor(diffMs / hour)} 小时前`;

  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  if (isSameDay(time, now)) return clock;
  if (isSameDay(time, new Date(now.getTime() - day))) return `昨天 ${clock}`;
  if (time.getFullYear() === now.getFullYear()) {
    return `${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
  }
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

/** 绝对时间（`2026-10-31 14:20`） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ` +
    `${pad(time.getHours())}:${pad(time.getMinutes())}`
  );
}

/** 同一天（按本地时区） */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 会话分组 —— 侧栏按「最后活跃时间」分桶（今天 / 昨天 / 最近 7 天 / 更早）。
 *
 * ⚠️ **只做归桶，不做排序** —— 顺序由服务端按 `last_active_at` 倒序给，
 * 这里保持原顺序往前拼桶，不自己重排。
 */
export type TimeBucket = 'today' | 'yesterday' | 'week' | 'older';

const DAY_MS = 24 * 60 * 60 * 1000;

export function timeBucket(iso: string | null | undefined): TimeBucket {
  if (!iso) return 'older';
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return 'older';

  const now = new Date();
  if (isSameDay(time, now)) return 'today';
  if (isSameDay(time, new Date(now.getTime() - DAY_MS))) return 'yesterday';
  if (now.getTime() - time.getTime() < 7 * DAY_MS) return 'week';
  return 'older';
}

/** 分组标题（顺序即展示顺序） */
export const TIME_BUCKET_LABELS: Record<TimeBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '最近 7 天',
  older: '更早',
};

/** 分组的展示顺序 */
export const TIME_BUCKET_ORDER: TimeBucket[] = ['today', 'yesterday', 'week', 'older'];
