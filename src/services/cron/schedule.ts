import { config } from '../../config.js';

/**
 * cron 表达式 —— **5 段：分 时 日 月 周**
 * （见 [12-b B11](./docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **按本地墙钟时间判定** —— cron 的语义就是墙钟，
 *    跨夏令时的那一小时会重复/跳过（与系统 cron 一致）。
 */

/** 一个 cron 表达式的解析结果 */
export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** 日字段是不是被限定过（`*` 之外） */
  domRestricted: boolean;
  /** 周字段是不是被限定过（`*` 之外） */
  dowRestricted: boolean;
}

/** 本地时间的各个字段 */
export interface LocalParts {
  year: number;
  /** 1 ~ 12 */
  month: number;
  /** 1 ~ 31 */
  day: number;
  /** 0 ~ 23 */
  hour: number;
  /** 0 ~ 59 */
  minute: number;
  /** 0 = 周日 */
  weekday: number;
}

/** 月份名 */
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 星期名（**从周日开始**） */
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 把名字换成数字 */
function nameToNumber(token: string, names: string[]): number | undefined {
  const index = names.indexOf(token.toLowerCase());
  return index === -1 ? undefined : index;
}

/**
 * 解析一个字段（`*` `a` `a-b` `星号斜杠n` `a-b/n` `a,b,c`）。
 *
 * @returns 解析出来的取值集合；不合法返回 null
 */
function parseField(field: string, min: number, max: number, names?: string[]): Set<number> | null {
  const out = new Set<number>();
  const trimmed = field.trim();
  if (trimmed === '') return null;

  for (const piece of trimmed.split(',')) {
    const part = piece.trim();
    if (part === '') return null;

    // ⚠️ **步长** —— `星号斜杠n` 与 `a-b/n`
    const [rangeText = '', stepText] = part.split('/');
    if (stepText !== undefined) {
      const step = Number(stepText);
      if (!Number.isInteger(step) || step <= 0) return null;
      let start: number;
      let end: number;
      if (!rangeText || rangeText.trim() === '*') {
        start = min;
        end = max;
      } else {
        const bounds = parseRange(rangeText.trim(), min, max, names);
        if (!bounds) return null;
        start = bounds[0];
        end = bounds[1];
      }
      for (let value = start; value <= end; value += step) out.add(value);
      continue;
    }

    if (part === '*') {
      for (let value = min; value <= max; value += 1) out.add(value);
      continue;
    }

    const bounds = parseRange(part, min, max, names);
    if (!bounds) return null;
    for (let value = bounds[0]; value <= bounds[1]; value += 1) out.add(value);
  }

  return out.size > 0 ? out : null;
}

/** 解析 `a` 或 `a-b` */
function parseRange(
  text: string,
  min: number,
  max: number,
  names?: string[],
): [number, number] | null {
  if (text.includes('-')) {
    const [leftText = '', rightText = ''] = text.split('-');
    const left = toNumber(leftText, min, max, names);
    const right = toNumber(rightText, min, max, names);
    if (left === undefined || right === undefined) return null;
    if (left > right) return null;
    return [left, right];
  }
  const value = toNumber(text, min, max, names);
  if (value === undefined) return null;
  return [value, value];
}

/** 一个取值（**允许名字**） */
function toNumber(text: string, min: number, max: number, names?: string[]): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (value < min || value > max) return undefined;
    return value;
  }

  if (names) {
    const named = nameToNumber(trimmed, names);
    if (named !== undefined) return named;
  }
  return undefined;
}

/**
 * 解析一个 cron 表达式。
 *
 * @returns 解析结果；不合法返回 `null`（**不抛异常** —— 调用方决定怎么报）
 */
export function parseCronExpression(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minutes = parseField(parts[0] as string, 0, 59);
  const hours = parseField(parts[1] as string, 0, 23);
  const daysOfMonth = parseField(parts[2] as string, 1, 31);
  const months = parseField(parts[3] as string, 1, 12, MONTH_NAMES);
  const daysOfWeekRaw = parseField(parts[4] as string, 0, 7, DAY_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeekRaw) return null;

  // ⚠️ **7 也表示周日** —— 归一成 0
  const daysOfWeek = new Set<number>();
  for (const value of daysOfWeekRaw) daysOfWeek.add(value === 7 ? 0 : value);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: (parts[2] as string).trim() !== '*',
    dowRestricted: (parts[4] as string).trim() !== '*',
  };
}

/** 表达式合法吗 */
export function isValidCron(expression: string): boolean {
  return parseCronExpression(expression) !== null;
}

/** 取某个时刻的本地墙钟字段 */
export function localParts(date: Date, timeZone: string = config.TIMEZONE): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekdayText = read('weekday');
  const weekday = DAY_NAMES.indexOf(weekdayText.toLowerCase());

  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')),
    minute: Number(read('minute')),
    weekday: weekday === -1 ? 0 : weekday,
  };
}

/** 某个月的天数 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 本地墙钟往前推一分钟（**处理月/年的进位**）。
 */
function previousMinute(parts: LocalParts): LocalParts {
  const next: LocalParts = { ...parts };
  next.minute -= 1;
  if (next.minute >= 0) return next;

  next.minute = 59;
  next.hour -= 1;
  if (next.hour >= 0) return next;

  next.hour = 23;
  next.day -= 1;
  if (next.day >= 1) return next;

  next.month -= 1;
  if (next.month >= 1) {
    next.day = daysInMonth(next.year, next.month);
    return next;
  }

  next.month = 12;
  next.year -= 1;
  next.day = 31;
  return next;
}

/**
 * 这一分钟要不要跑。
 *
 * ⚠️ **日与周都限定时取「或」** —— 这是 cron 的标准语义
 *    （`0 9 1 * 1` = 每月 1 号或每周一）。
 */
export function matchesCron(parts: LocalParts, fields: CronFields): boolean {
  if (!fields.minutes.has(parts.minute)) return false;
  if (!fields.hours.has(parts.hour)) return false;
  if (!fields.months.has(parts.month)) return false;

  const domHit = fields.daysOfMonth.has(parts.day);
  const dowHit = fields.daysOfWeek.has(parts.weekday);
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/** 往前找多少分钟（**上限 14 天** —— 再久就没意义了） */
const MAX_LOOKBACK_MINUTES = 14 * 24 * 60;

/**
 * 从 `to` 往前找最近的到期时刻（**含 `to` 那一分钟**）。
 *
 * @returns 到期时刻（epoch 毫秒，倒序）；没有到期点返回空数组
 */
export function previousOccurrences(
  fields: CronFields,
  to: Date,
  options: { timeZone?: string; lookbackMinutes?: number } = {},
): number[] {
  const timeZone = options.timeZone ?? config.TIMEZONE;
  const limit = Math.min(options.lookbackMinutes ?? MAX_LOOKBACK_MINUTES, MAX_LOOKBACK_MINUTES);

  const out: number[] = [];
  let current = localParts(to, timeZone);
  const toMinute = Math.floor(to.getTime() / 60_000) * 60_000;

  for (let step = 0; step <= limit; step += 1) {
    if (matchesCron(current, fields)) {
      // ⚠️ **把本地时间对回真实时刻** —— 用「距 now 多少分钟」推算，
      //    夏令时切换的那一小时会差几分钟（与系统 cron 一样，不追求完美）
      out.push(toMinute - step * 60_000);
    }
    current = previousMinute(current);
  }

  return out;
}

/**
 * 数一数 `(from, to]` 之间有多少个到期点 —— **用来发现「错过了」**。
 */
export function countOccurrences(
  fields: CronFields,
  from: Date,
  to: Date,
  options: { timeZone?: string } = {},
): number {
  const occurrences = previousOccurrences(fields, to, {
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  const fromTime = from.getTime();
  return occurrences.filter((time) => time > fromTime).length;
}
