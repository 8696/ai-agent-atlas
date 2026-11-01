import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { useTempDatabase } from '../fixtures/db';

/* eslint-disable @typescript-eslint/require-await --
 * 假模型的 `stream` 是 **async generator** —— `async` 是签名
 * （`AsyncGenerator`）要求的，不是误用；它只 yield、没有 await。
 */

/**
 * 定时任务的集成测试 —— **真图 · 真 SQLite · 假模型**。
 *
 * 覆盖（[12-b B11](../docs/12-b-需求-对话与编排.md) 的验收项）：
 * - 到点自动跑，结果写进指定会话
 * - 触发时需要人工确认 → **跳过该步并记录**，任务不挂死
 * - `CRON_ENABLED=false` → 调度器不触发
 * - 错过的时间点 → 跳过并记账
 */

// ⚠️ **静音日志** —— pino 会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

/** 假模型的一次输出 */
interface Step {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
}

/** 假模型的脚本 */
let script: Step[] = [];

/** 被调用过的工具 */
let executed: string[] = [];

vi.mock('../../src/services/model', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/model')>(
    '../../src/services/model',
  );
  return {
    ...actual,
    resolveModel: () => ({
      name: 'fake-model',
      baseUrl: 'http://fake.local',
      apiKey: 'fake-key',
      modelId: 'fake-model',
      maxTokens: 1024,
      temperature: 1,
      thinkingBudget: 0,
    }),
    resolveFallback: () => undefined,
    createChatModel: () => {
      const model = {
        bindTools: () => model,
        stream: async function* () {
          const step = script.shift();
          if (!step) return;
          if (step.text) yield { text: step.text };
          if (step.tool) {
            yield {
              tool_call_chunks: [
                {
                  index: 0,
                  id: `call_${step.tool.name}_${executed.length}`,
                  name: step.tool.name,
                  args: JSON.stringify(step.tool.args),
                },
              ],
            };
          }
        },
        invoke: async () => ({ content: '' }),
      };
      return model;
    },
  };
});

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { setToolRegistry } = await import('../../src/tools/registry');
const { config } = await import('../../src/config');
const { addCronTask, loadCronTasks, updateCronTask } = await import('../../src/services/cron/store');
const { tickCron } = await import('../../src/services/cron/scheduler');
const { createSession } = await import('../../src/services/session');
const { listMessages } = await import('../../src/services/message');
const { FILES } = await import('../../src/config/paths');

/** 一个假工具 */
function fakeTool(name: string, sensitivity: 'low' | 'normal' | 'high') {
  return {
    name,
    description: `假工具 ${name}`,
    schema: z.object({}),
    sensitivity,
    source: 'builtin' as const,
    enabled: true,
    executor: 'local' as const,
    invoke: () => {
      executed.push(name);
      return Promise.resolve({ ok: true, output: `${name} 跑完了` });
    },
  };
}

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
});

afterAll(() => {
  setToolRegistry(undefined);
});

beforeEach(() => {
  script = [];
  executed = [];
  // ⚠️ **任务表清零** —— 上一条用例的任务会跟这一条抢模型脚本
  writeFileSync(FILES.cron, JSON.stringify({ tasks: [] }), 'utf8');
  setToolRegistry({
    list: () => [fakeTool('safe_tool', 'low'), fakeTool('danger_tool', 'high')],
    get: (name: string) =>
      [fakeTool('safe_tool', 'low'), fakeTool('danger_tool', 'high')].find(
        (tool) => tool.name === name,
      ),
    names: () => ['safe_tool', 'danger_tool'],
  });
});

/** 加一条任务 */
async function addTask(options: {
  cron: string;
  prompt: string;
  autoApprove?: string[];
  lastRunAt?: string;
}): Promise<string> {
  const session = await createSession({ title: '定时任务测试' });
  const task = addCronTask({
    name: '测试任务',
    schedule: options.cron,
    cron: options.cron,
    prompt: options.prompt,
    sessionId: session.id,
    autoApprove: options.autoApprove ?? [],
  });
  if (options.lastRunAt) {
    updateCronTask(task.id, { lastRunAt: options.lastRunAt });
  }
  return task.id;
}

describe('定时任务调度', () => {
  it('到点自动跑，结果写进指定会话', async () => {
    const taskId = await addTask({ cron: '* * * * *', prompt: '说句话' });
    script = [{ text: '定时任务跑完了' }];

    await tickCron(new Date('2026-10-31T01:00:00Z'));

    const tasks = loadCronTasks();
    const task = tasks.find((item) => item.id === taskId);
    expect(task?.lastStatus).toBe('success');

    // 📌 **结果落进会话** —— 前端刷新就能看到
    const sessionId = task?.sessionId ?? '';
    const messages = await listMessages(sessionId);
    expect(messages.some((message) => message.content.includes('定时任务跑完了'))).toBe(true);
    // 📌 **用户那条也在**（任务指令本身）
    expect(messages.some((message) => message.role === 'user')).toBe(true);
  });

  it('⚠️ 触发时需要人工确认 → 跳过该步并记录，任务不挂死', async () => {
    const taskId = await addTask({ cron: '* * * * *', prompt: '跑个危险工具' });
    script = [{ tool: { name: 'danger_tool', args: {} } }];

    await tickCron(new Date('2026-10-31T01:00:00Z'));

    const task = loadCronTasks().find((item) => item.id === taskId);
    expect(task?.lastStatus).toBe('skipped');
    expect(task?.lastError).toContain('人工确认');
    // ⚠️ **危险工具没被执行**
    expect(executed).not.toContain('danger_tool');
  });

  it('⚠️ 显式声明 autoApprove → 无人值守时放行', async () => {
    const taskId = await addTask({
      cron: '* * * * *',
      prompt: '跑个危险工具',
      autoApprove: ['danger_tool'],
    });
    script = [{ tool: { name: 'danger_tool', args: {} } }, { text: '跑完了' }];

    await tickCron(new Date('2026-10-31T01:00:00Z'));

    expect(executed).toContain('danger_tool');
    const task = loadCronTasks().find((item) => item.id === taskId);
    expect(task?.lastStatus).toBe('success');
  });

  it('⚠️ 错过的时间点 → 跳过，不补跑', async () => {
    const taskId = await addTask({
      cron: '0 9 * * *',
      prompt: '每天都跑',
      // ⚠️ **上次跑是三天前** —— 中间的三次都错过了
      lastRunAt: new Date('2026-10-28T01:00:00Z').toISOString(),
    });

    await tickCron(new Date('2026-10-31T01:30:00Z'));

    const task = loadCronTasks().find((item) => item.id === taskId);
    // 📌 **没跑** —— 09:00 那一档已经过去了
    expect(executed).toHaveLength(0);
    expect(task?.lastStatus).toBe('');
    // 📌 **但时间戳推进了** —— 不然每次都要重数一遍
    expect(new Date(task?.lastRunAt ?? 0).getTime()).toBeGreaterThan(
      new Date('2026-10-31T01:30:00Z').getTime() - 60_000,
    );
  });

  it('⚠️ CRON_ENABLED=false → 调度器不触发', async () => {
    const taskId = await addTask({ cron: '* * * * *', prompt: '说句话' });
    script = [{ text: '不该跑' }];

    const before = config.CRON_ENABLED;
    config.CRON_ENABLED = false;
    try {
      await tickCron(new Date('2026-10-31T01:00:00Z'));
    } finally {
      config.CRON_ENABLED = before;
    }

    expect(executed).toHaveLength(0);
    const task = loadCronTasks().find((item) => item.id === taskId);
    expect(task?.lastStatus).toBe('');
  });

  it('同一分钟不重复跑', async () => {
    const taskId = await addTask({ cron: '* * * * *', prompt: '说句话' });
    script = [{ text: '第一次' }, { text: '第二次' }];

    const now = new Date('2026-10-31T01:00:00Z');
    await tickCron(now);
    await tickCron(now);

    const task = loadCronTasks().find((item) => item.id === taskId);
    expect(task?.lastStatus).toBe('success');
    // 📌 **只跑了一次**
    const sessionId = task?.sessionId ?? '';
    const messages = await listMessages(sessionId);
    expect(messages.filter((message) => message.content.includes('第一次'))).toHaveLength(1);
  });
});

describe('定时任务工具（对话内管理）', () => {
  it('add → list → disable → remove 全链路可用', async () => {
    const { cronTool } = await import('../../src/tools/builtin/cron.js');

    const added = await cronTool.invoke(
      { action: 'add', name: '日报', schedule: '0 9 * * *', prompt: '提醒我看日报' },
      { sessionId: 'session-cron-tool' },
    );
    expect(added.ok).toBe(true);
    const id = (added.data as { id?: string }).id;
    expect(id).toBeTruthy();

    // 📌 **任务写进当前会话** —— 结果落在用户正在聊的会话里
    const task = loadCronTasks().find((item) => item.id === id);
    expect(task?.sessionId).toBe('session-cron-tool');
    expect(task?.cron).toBe('0 9 * * *');

    const listed = await cronTool.invoke({ action: 'list' }, {});
    expect(listed.output).toContain('日报');

    const disabled = await cronTool.invoke({ action: 'disable', id }, {});
    expect(disabled.ok).toBe(true);
    expect(loadCronTasks().find((item) => item.id === id)?.enabled).toBe(false);

    const removed = await cronTool.invoke({ action: 'remove', id }, {});
    expect(removed.ok).toBe(true);
    expect(loadCronTasks().find((item) => item.id === id)).toBeUndefined();
  });

  it('⚠️ 缺参数 → 明确报错，不装成功', async () => {
    const { cronTool } = await import('../../src/tools/builtin/cron.js');

    const noSchedule = await cronTool.invoke({ action: 'add', prompt: 'x' }, {});
    expect(noSchedule.ok).toBe(false);
    expect(noSchedule.output).toContain('schedule');

    const noPrompt = await cronTool.invoke({ action: 'add', schedule: '0 9 * * *' }, {});
    expect(noPrompt.ok).toBe(false);
    expect(noPrompt.output).toContain('prompt');

    const unknown = await cronTool.invoke({ action: 'remove', id: '不存在的 id' }, {});
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toContain('没有这个定时任务');
  });
});
