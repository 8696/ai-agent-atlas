import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { z } from 'zod';
import { config } from '../../config.js';
import { parseArgs } from '../args.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * `current_time` —— 当前时间 / 时区（**纯本地计算，不出网**）。
 *
 * 📌 **时区默认取 `.env` 的 `TIMEZONE`**。
 */

dayjs.extend(utc);
dayjs.extend(timezone);

/** 同步结果 → Promise（**工具实现可以是同步的**） */
function done(result: ToolResult): Promise<ToolResult> {
  return Promise.resolve(result);
}

const currentTimeSchema = z.object({
  /** 时区（**如 `Asia/Shanghai`；默认用配置里的**） */
  timezone: z.string().min(1).max(64).optional(),
  /** 要不要同时给 Unix 时间戳 */
  withTimestamp: z.boolean().optional(),
});

export const currentTimeTool: ToolDefinition = {
  name: 'current_time',
  description:
    '取当前日期与时间。默认用配置的时区（Asia/Shanghai），也可以传别的时区。' +
    '纯本地计算，不联网。',
  schema: currentTimeSchema,
  sensitivity: 'low',
  keywords: ['时间', '几点', '几号', '日期', '星期', 'today', 'now', 'time'],
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  invoke(args): Promise<ToolResult> {
    try {
      const input = parseArgs(currentTimeSchema, args);
      const zone = input.timezone ?? config.TIMEZONE;
      const now = dayjs().tz(zone);
      const lines = [
        `当前时间：${now.format('YYYY-MM-DD HH:mm:ss')}`,
        `时区：${zone}`,
        `星期：${now.format('dddd')}`,
      ];
      if (input.withTimestamp) {
        lines.push(`Unix 时间戳：${now.unix()}`);
      }
      return done({
        ok: true,
        output: lines.join('\n'),
        data: {
          iso: now.toISOString(),
          timezone: zone,
          timestamp: now.unix(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return done({ ok: false, output: `取时间失败：${message}`, error: message });
    }
  },
};

/** 时间工具 */
export const timeTools: ToolDefinition[] = [currentTimeTool];
