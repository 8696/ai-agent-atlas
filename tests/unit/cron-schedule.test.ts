import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
import {
  countOccurrences,
  isValidCron,
  localParts,
  matchesCron,
  parseCronExpression,
  previousOccurrences,
} from '../../src/services/cron/schedule';
import {
  addCronTask,
  loadCronTasks,
  removeCronTask,
  updateCronTask,
} from '../../src/services/cron/store';
import { cleanExpression } from '../../src/services/cron/parse';

/**
 * 定时任务的单元测试 —— **纯函数 + 文件读写，不调模型**。
 *
 * 覆盖（[12-b B11](../../docs/12-b-需求-对话与编排.md)）：
 * - cron 表达式解析与匹配
 * - 「错过了 N 次」怎么算
 * - 任务表的增删改
 */

const TZ = 'Asia/Shanghai';

describe('cron 表达式', () => {
  it('合法的表达式能解析', () => {
    expect(isValidCron('0 9 * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9-18 * * 1-5')).toBe(true);
    expect(isValidCron('30 8 1 * *')).toBe(true);
    expect(isValidCron('0 9 * * mon')).toBe(true);
  });

  it('⚠️ 不合法的表达式 → null（不抛异常）', () => {
    expect(isValidCron('0 9 * *')).toBe(false);
    expect(isValidCron('0 99 * * *')).toBe(false);
    expect(isValidCron('abc')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });

  it('分钟 / 小时 / 星期都能对上', () => {
    const fields = parseCronExpression('30 8 * * 1');
    expect(fields).not.toBeNull();
    if (!fields) return;

    // 2026-10-26 是周一
    const monday = new Date('2026-10-26T00:30:00Z'); // 08:30 上海
    expect(matchesCron(localParts(monday, TZ), fields)).toBe(true);
    expect(matchesCron(localParts(new Date('2026-10-27T00:30:00Z'), TZ), fields)).toBe(false);
  });

  it('⚠️ 日与周都限定 → 取「或」（cron 标准语义）', () => {
    const fields = parseCronExpression('0 9 1 * 1');
    expect(fields).not.toBeNull();
    if (!fields) return;

    // 每月 1 号 或 每周一
    expect(matchesCron(localParts(new Date('2026-11-01T01:00:00Z'), TZ), fields)).toBe(true);
    expect(matchesCron(localParts(new Date('2026-11-02T01:00:00Z'), TZ), fields)).toBe(true); // 周一
    expect(matchesCron(localParts(new Date('2026-11-03T01:00:00Z'), TZ), fields)).toBe(false);
  });

  it('时区会影响「今天几点」', () => {
    const instant = new Date('2026-10-31T01:00:00Z');
    expect(localParts(instant, TZ).hour).toBe(9);
    expect(localParts(instant, 'UTC').hour).toBe(1);
  });
});

describe('到期时刻', () => {
  it('当前分钟匹配 → 找得到', () => {
    const fields = parseCronExpression('0 9 * * *');
    if (!fields) throw new Error('表达式坏了');
    const now = new Date('2026-10-31T01:00:00Z'); // 09:00 上海
    const occurrences = previousOccurrences(fields, now, { timeZone: TZ });
    expect(occurrences).toContain(Math.floor(now.getTime() / 60_000) * 60_000);
  });

  it('不匹配 → 这一分钟没有到期点', () => {
    const fields = parseCronExpression('0 9 * * *');
    if (!fields) throw new Error('表达式坏了');
    const now = new Date('2026-10-31T01:30:00Z'); // 09:30 上海
    const occurrences = previousOccurrences(fields, now, { timeZone: TZ });
    expect(occurrences).not.toContain(Math.floor(now.getTime() / 60_000) * 60_000);
  });

  it('⚠️ 错过的时间点能被数出来（默认跳过，不补跑）', () => {
    const fields = parseCronExpression('0 9 * * *');
    if (!fields) throw new Error('表达式坏了');
    // 从昨天 09:00 到今天 09:30 之间应该错过 1 次（今天 09:00）
    const from = new Date('2026-10-30T01:00:00Z');
    const to = new Date('2026-10-31T01:30:00Z');
    expect(countOccurrences(fields, from, to, { timeZone: TZ })).toBe(1);
  });

  it('没错过就是 0', () => {
    const fields = parseCronExpression('0 9 * * *');
    if (!fields) throw new Error('表达式坏了');
    const from = new Date('2026-10-31T00:30:00Z');
    const to = new Date('2026-10-31T00:45:00Z');
    expect(countOccurrences(fields, from, to, { timeZone: TZ })).toBe(0);
  });
});

describe('任务表', () => {
  /** 一个临时任务表文件 */
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cron-'));
    const path = join(dir, 'cron.json');
    writeFileSync(path, JSON.stringify({ tasks: [] }), 'utf8');
    return path;
  }

  it('加一条 → 能读回来', () => {
    const path = tempFile();
    addCronTask(
      {
        name: '每日简报',
        schedule: '每天早上 9 点',
        cron: '0 9 * * *',
        prompt: '总结昨天',
        sessionId: 'sess-1',
      },
      path,
    );

    const tasks = loadCronTasks(path);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.name).toBe('每日简报');
    expect(tasks[0]?.cron).toBe('0 9 * * *');
    expect(tasks[0]?.lastRunAt).not.toBe('');
  });

  it('删一条 → 真的没了', () => {
    const path = tempFile();
    const task = addCronTask(
      { name: 'x', schedule: '每天 9 点', cron: '0 9 * * *', prompt: 'p', sessionId: 's' },
      path,
    );
    expect(removeCronTask(task.id, path)).toBe(true);
    expect(loadCronTasks(path)).toHaveLength(0);
    expect(removeCronTask(task.id, path)).toBe(false);
  });

  it('改一条 → 状态能存回去', () => {
    const path = tempFile();
    const task = addCronTask(
      { name: 'x', schedule: '每天 9 点', cron: '0 9 * * *', prompt: 'p', sessionId: 's' },
      path,
    );
    updateCronTask(task.id, { lastStatus: 'success', lastRunAt: '2026-10-31T01:00:00.000Z' }, path);
    const updated = loadCronTasks(path)[0];
    expect(updated?.lastStatus).toBe('success');
  });

  it('⚠️ 文件坏了 → 当成空表（不让整个 Agent 起不来）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cron-bad-'));
    const path = join(dir, 'cron.json');
    writeFileSync(path, '{ 这不是 JSON', 'utf8');
    expect(loadCronTasks(path)).toEqual([]);
  });

  it('文件不存在 → 空表', () => {
    expect(loadCronTasks('/tmp/atlas-not-exists-cron.json')).toEqual([]);
  });

  it('写盘是原子的（不留临时文件）', () => {
    const path = tempFile();
    addCronTask(
      { name: 'x', schedule: '每天 9 点', cron: '0 9 * * *', prompt: 'p', sessionId: 's' },
      path,
    );
    const raw = readFileSync(path, 'utf8');
    expect(JSON.parse(raw)).toHaveProperty('tasks');
    expect(raw.includes('.tmp-')).toBe(false);
  });
});

describe('模型回复的清洗', () => {
  it('去掉代码块', () => {
    expect(cleanExpression('```cron\n0 9 * * *\n```')).toBe('0 9 * * *');
  });

  it('只取第一行', () => {
    expect(cleanExpression('0 9 * * *\n每天早上九点')).toBe('0 9 * * *');
  });

  it('去掉引号', () => {
    expect(cleanExpression('"0 9 * * *"')).toBe('0 9 * * *');
  });
});
