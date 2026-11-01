import { createHash } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { writeAudit } from '../lib/audit.js';
import { parseArgs, schemas } from '../tools/args.js';
import { truncateOutput } from '../tools/output.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import { getGraph } from './graph.js';
import { Semaphore } from './subagent-pool.js';

/**
 * 子代理 —— **主 Agent 把子任务派给隔离上下文的子代理**
 * （见 [12-b B10](./docs/12-b-需求-对话与编排.md)）。
 *
 * | 东西         | 规则                                                       |
 * | ------------ | ---------------------------------------------------------- |
 * | 上下文       | **隔离** —— 只拿得到「任务」，看不到主对话的历史             |
 * | 线程         | **独立 thread_id** —— 不跟主对话抢检查点                     |
 * | 工具池       | **共用** —— 同一套工具、同一套权限策略                       |
 * | 人工确认     | **不绕过** —— 子代理跑 `shell` 照样要弹确认                  |
 * | 步数上限     | `SUBAGENT_MAX_STEPS`（默认 8）                              |
 * | 并发上限     | `SUBAGENT_MAX_CONCURRENCY`（默认 3）—— 满了排队             |
 * | 回灌         | **摘要**（默认 2000 字符）—— 不是全量过程                   |
 *
 * 📌 **子代理能再派一层**（限深度）——
 *    深度上限是 `SUBAGENT_MAX_DEPTH`（默认 2 = 主代理 → 子代理 → 孙代理），
 *    到了上限那一层就**看不见 `spawn_subagent` 工具**（模型看不见就不会调）。
 */

/** 摘要长度上限（**回灌给主 Agent 的只有这一段**） */
const SUMMARY_MAX_CHARS = 2000;

/**
 * 这一层还能不能再派子代理。
 *
 * 📌 **深度上限 `SUBAGENT_MAX_DEPTH`（默认 2）** ——
 *    0 = 主代理（能派）· 1 = 子代理（能派孙代理）· 2 = 孙代理（**到顶了**）。
 *
 * ⚠️ **不靠「子代理看不见工具」防递归** —— 到了上限那一层
 *    **模型就看不见 `spawn_subagent`**（见 `nodes/plan.ts`），
 *    所以它连想派都派不出去。
 */
export function canSpawnSubagent(depth: number, maxDepth = config.SUBAGENT_MAX_DEPTH): boolean {
  return depth < maxDepth;
}

/**
 * 回灌给主 Agent 的整段文本。
 *
 * ⚠️ **上限管的是「整段」** —— 前面那句「子代理 xx 跑完了」也是回灌内容，
 *    只截摘要的话实际进上下文的会多出几十个字符
 *    （以前就是这样 —— 摘要 2000 字 + 前缀，上限形同虚设）。
 */
function subagentOutput(name: string, steps: number, summary: string): string {
  const head = `子代理「${name}」跑完了（用了 ${steps} 次工具）。\n\n`;
  const room = Math.max(0, SUMMARY_MAX_CHARS - head.length);
  const body = summary.length > room ? summary.slice(0, room) : summary;
  return head + body;
}

/** `spawn_subagent` 的入参 */
const spawnSchema = z.object({
  /** 子任务描述（**子代理只看得到这一条**） */
  task: schemas.text(4000),
  /** 子代理的名字（**可选** —— 给用户看的） */
  name: schemas.text(64).optional(),
  /** 模型（**可选** —— 默认继承主模型；只认主模型与备用模型） */
  model: schemas.text(64).optional(),
});

/**
 * 子代理的 thread_id —— **同一个工具调用重跑时是同一个**。
 *
 * ⚠️ **必须稳定** —— 父图恢复时会重跑这个节点，
 *    thread_id 变了就等于开了个新子代理，前面的进度全丢。
 *
 * 📌 **深度要算进去** —— 不同层的子代理可能拿到同样的工具调用 id，
 *    不带深度的话两层会撞到同一个 thread 上（**检查点串了**）。
 */
export function subagentThreadId(
  sessionId: string | undefined,
  toolCallId: string | undefined,
  depth = 0,
): string {
  const seed = `${sessionId ?? ''}::${toolCallId ?? ''}::${depth}`;
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  return `subagent:${digest}`;
}

/** 进程内的并发闸（**上限来自配置**） */
let pool: Semaphore | undefined;

/** 拿到并发闸 */
export function getSubagentPool(): Semaphore {
  if (!pool) pool = new Semaphore(config.SUBAGENT_MAX_CONCURRENCY);
  return pool;
}

/** 测试用：换掉并发闸 */
export function setSubagentPool(next: Semaphore | undefined): void {
  pool = next;
}

/**
 * 已跑完的子代理结果（**按工具调用 id 记**）。
 *
 * ⚠️ **为什么要有这个** —— 父图节点里并行派了 2 个子代理，
 *    其中一个要人工确认 → 父图挂起 → 恢复时**整个节点重跑**。
 *    没有这个表，已经跑完的那个子代理会被**执行第二遍**
 *    （白烧钱，还可能有副作用）。
 *
 * 📌 **只存在进程内** —— 后端重启后这个表是空的，
 *    那种情况下已完成的子代理会重跑（可接受，重跑的是幂等任务）。
 */
const completed = new Map<string, SubagentResult>();

/** 表的上限（**别让它无限涨**） */
const MEMO_LIMIT = 50;

/**
 * 读已完成的结果。
 *
 * 📌 **按 thread_id 记** —— thread_id 里带深度，
 *    不同层的子代理不会撞到同一格（见 `subagentThreadId`）。
 */
export function memoizedSubagent(threadId: string | undefined): SubagentResult | undefined {
  if (!threadId) return undefined;
  return completed.get(threadId);
}

/** 记一个已完成的结果 */
function rememberSubagent(threadId: string | undefined, result: SubagentResult): void {
  if (!threadId) return;
  completed.set(threadId, result);
  // ⚠️ **先进先出** —— 超过上限就丢最老的
  while (completed.size > MEMO_LIMIT) {
    const oldest = completed.keys().next();
    if (oldest.done) break;
    completed.delete(oldest.value);
  }
}

/** 测试用：清空已完成表 */
export function clearSubagentMemo(): void {
  completed.clear();
}

/** 子代理跑完的结果 */
export interface SubagentResult {
  /** 子代理名 */
  name: string;
  /** 摘要（**截断过**） */
  summary: string;
  /** 用了几个工具 */
  steps: number;
  /** 摘要被截断了 */
  truncated: boolean;
}

/**
 * 跑一个子代理。
 *
 * ⚠️ **要人工确认时，中断会一路冒泡到父图** ——
 *    父图因此挂起，用户点批准后从检查点续跑，子代理接着往下走
 *    （这是 LangGraph 的原生嵌套中断语义）。
 * ⚠️ **这里不要 catch 图中断** —— 吞了就等于「子代理绕过确认」。
 */
export async function runSubagent(options: {
  task: string;
  name: string;
  threadId: string;
  sessionId?: string | undefined;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  /** ⚠️ **这一层是第几层**（1 = 子代理 · 2 = 孙代理） */
  depth?: number | undefined;
}): Promise<SubagentResult> {
  const graph = getGraph();
  // 📌 **子代理的消息 id 带前缀** —— 工具流水里能一眼看出
  //    「这几条是子代理跑的」（见 [12-c C6](./docs/12-c-需求-工具技能与扩展.md)）
  const messageId = `subagent:${nanoid()}`;

  const stream = (await graph.stream(
    {
      turnMessages: [new HumanMessage(options.task)],
      sessionId: options.sessionId ?? '',
      messageId,
      // ⚠️ **隔离** —— 子代理不加载主对话的历史与摘要
      isolated: true,
      // 📌 **子代理自己的步数上限**
      maxSteps: config.SUBAGENT_MAX_STEPS,
      // 📌 **深度** —— 这一层还能不能继续派（见 `SUBAGENT_MAX_DEPTH`）
      depth: options.depth ?? 1,
      // 📌 **子代理可以指定模型**（默认继承主模型）
      ...(options.model ? { model: options.model } : {}),
    },
    {
      configurable: { thread_id: options.threadId },
      /**
       * ⚠️ **子代理的中间输出不进主对话** ——
       *    内层图默认继承父图的 writer，子代理的正文会串进用户的流里。
       *    这里换成一个「丢弃」的 writer：**主对话只看到子代理的摘要**。
       */
      writer: () => {},
      streamMode: ['custom', 'values'] as never,
      ...(options.signal ? { signal: options.signal } : {}),
      // ⚠️ **`writer` 不在 LangGraph 的类型里** —— 但运行时确实认它
    } as never,
  )) as unknown as AsyncIterable<unknown>;

  let text = '';
  let steps = 0;
  for await (const chunk of stream) {
    const [mode, payload] = chunk as [string, unknown];
    if (mode !== 'values') continue;
    const value = (payload ?? {}) as { finalText?: unknown; steps?: unknown };
    if (typeof value.finalText === 'string') text = value.finalText;
    if (typeof value.steps === 'number') steps = value.steps;
  }

  const clipped = truncateOutput(text, SUMMARY_MAX_CHARS, config.TOOL_OUTPUT_TRUNCATE);
  return {
    name: options.name,
    summary: clipped.text,
    steps,
    truncated: clipped.truncated,
  };
}

/**
 * 派发子代理的工具。
 *
 * ⚠️ **派发本身是一次工具调用** —— 走统一入口与权限闸
 *    （见 [12-c C1](./docs/12-c-需求-工具技能与扩展.md)）。
 */
export const spawnSubagentTool: ToolDefinition = {
  name: 'spawn_subagent',
  description:
    '把一个子任务派给**隔离上下文的子代理**并行执行。' +
    '子代理只看得见你给的这段任务，看不见主对话的历史；' +
    '它能用同一套工具（危险操作照样要人确认），跑完只回一段摘要。' +
    '适合「同时查 A 和 B 两件事」这种能拆开的活。',
  schema: spawnSchema,
  sensitivity: 'normal',
  riskNote: '会派一个子代理去跑这个子任务 —— 它能用同一套工具，但看不到主对话的历史。',
  source: 'builtin',
  enabled: true,
  // 📌 **子代理也能派**（限深度）—— `SUBAGENT_MAX_DEPTH`（默认 2）
  //    到了深度上限，这一层就**看不见这个工具**（见 `nodes/plan.ts`）
  executor: 'subagent',
  async invoke(args: unknown, context): Promise<ToolResult> {
    const input = parseArgs(spawnSchema, args);
    const name = input.name?.trim() || `子代理 ${nanoid(4)}`;
    // 📌 **深度** —— 主代理是 0，子代理是 1，孙代理是 2
    const depth = context.depth ?? 0;
    const threadId = subagentThreadId(context.sessionId, context.toolCallId, depth);

    // 📌 **已经跑过就别再跑一遍** —— 父图恢复时整个节点会重跑
    const memo = memoizedSubagent(threadId);
    if (memo) {
      return {
        ok: true,
        output: subagentOutput(memo.name, memo.steps, memo.summary || '(没有产出)'),
        data: {
          name: memo.name,
          task: input.task,
          summary: memo.summary,
          steps: memo.steps,
          truncated: memo.truncated,
        },
      };
    }

    // 📌 **并发闸** —— 满了排队，不报错
    const gate = getSubagentPool();
    await gate.acquire();
    try {
      await writeAudit('SUBAGENT_SPAWNED', 'subagent', threadId, {
        name,
        sessionId: context.sessionId,
        task: input.task.slice(0, 500),
      });

      const result = await runSubagent({
        task: input.task,
        name,
        threadId,
        // 📌 **深度 +1** —— 这一层是子代理，它自己还能不能派由 `SUBAGENT_MAX_DEPTH` 判
        depth: depth + 1,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      rememberSubagent(threadId, result);

      logger.info(
        { subagent: name, steps: result.steps, threadId },
        '子代理跑完了',
      );

      return {
        ok: true,
        output: subagentOutput(name, result.steps, result.summary || '(没有产出)'),
        data: {
          name,
          task: input.task,
          summary: result.summary,
          steps: result.steps,
          truncated: result.truncated,
        },
      };
    } finally {
      // ⚠️ **中断冒泡时也要还名额** —— 不然并发上限会被慢慢耗光
      gate.release();
    }
  },
};

/** 子代理工具组 */
export function subagentToolGroups(): Array<{ source: 'builtin'; tools: ToolDefinition[] }> {
  return [{ source: 'builtin', tools: [spawnSubagentTool] }];
}
