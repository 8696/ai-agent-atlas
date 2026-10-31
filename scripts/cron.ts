import { initDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';
import { parseScheduleToCron } from '../src/services/cron/parse.js';
import { createSession } from '../src/services/session.js';
import { addCronTask, describeCronTask, loadCronTasks, removeCronTask } from '../src/services/cron/store.js';

/**
 * 定时任务命令行 —— `yarn cron:list` · `yarn cron:add` · `yarn cron:remove`
 * （见 [12-b B11](../docs/12-b-需求-对话与编排.md)）。
 *
 * ```bash
 * yarn cron:list
 * yarn cron:add --schedule "每天早上 9 点" --prompt "总结昨天的对话"
 * yarn cron:add --schedule "0 9 * * *" --prompt "总结昨天的对话" --session <会话 id>
 * yarn cron:remove <任务 id 或名字>
 * ```
 *
 * ⚠️ **周期描述可以写自然语言** —— 由模型解析成 cron 表达式，
 *    解析结果存进任务文件（**不每次重解析**）。
 */

/** 命令行参数 */
interface CliArgs {
  command: string;
  name?: string | undefined;
  schedule?: string | undefined;
  prompt?: string | undefined;
  session?: string | undefined;
  autoApprove: string[];
  id?: string | undefined;
}

/** 解析参数 */
function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: argv[0] ?? 'list', autoApprove: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--name' && next) {
      out.name = next;
      i += 1;
    } else if (arg === '--schedule' && next) {
      out.schedule = next;
      i += 1;
    } else if (arg === '--prompt' && next) {
      out.prompt = next;
      i += 1;
    } else if (arg === '--session' && next) {
      out.session = next;
      i += 1;
    } else if (arg === '--auto-approve' && next) {
      out.autoApprove = next
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      i += 1;
    } else if (arg && !arg.startsWith('--')) {
      out.id = arg;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initDatabase();

  if (args.command === 'list') {
    const tasks = loadCronTasks();
    if (tasks.length === 0) {
      console.info('（还没有定时任务）');
      console.info('加一条：yarn cron:add --schedule "每天早上 9 点" --prompt "总结昨天的对话"');
      return;
    }
    console.info(`共 ${tasks.length} 条：`);
    for (const task of tasks) {
      console.info(`${task.id}  ${describeCronTask(task)}`);
    }
    return;
  }

  if (args.command === 'add') {
    const schedule = args.schedule?.trim();
    const prompt = args.prompt?.trim();
    if (!schedule) {
      console.error('缺少 --schedule（周期描述或 cron 表达式）');
      process.exit(1);
    }
    if (!prompt) {
      console.error('缺少 --prompt（任务指令）');
      process.exit(1);
    }

    // 📌 **解析一次，存下来** —— 不每次重解析
    const expression = await parseScheduleToCron(schedule);

    const sessionId = args.session ?? (await createSession({ title: `定时任务 · ${args.name ?? schedule}` })).id;

    const task = addCronTask({
      name: args.name ?? schedule,
      schedule,
      cron: expression,
      prompt,
      sessionId,
      autoApprove: args.autoApprove,
    });

    console.info(`已加定时任务：${task.id}`);
    console.info(describeCronTask(task));
    if (args.autoApprove.length > 0) {
      console.info(`⚠️ 自动放行：${args.autoApprove.join('、')} —— 无人值守时这些工具不再弹确认`);
    }
    return;
  }

  if (args.command === 'remove') {
    if (!args.id) {
      console.error('缺少任务 id 或名字（yarn cron:remove <任务 id>）');
      process.exit(1);
    }
    // 📌 **id 或名字都能删** —— 名字是自己起的，比 id 好记
    const tasks = loadCronTasks();
    const target =
      tasks.find((task) => task.id === args.id) ??
      tasks.find((task) => task.name === args.id);
    if (!target) {
      console.error(`没有这个任务：${args.id}`);
      process.exit(1);
    }
    removeCronTask(target.id);
    console.info(`已删定时任务：${target.id}（${target.name}）`);
    return;
  }

  console.error(`未知命令：${args.command}（可用：list / add / remove）`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '定时任务命令失败');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
