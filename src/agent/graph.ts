import { END, START, StateGraph } from '@langchain/langgraph';
import { config } from '../config.js';
import { AtlasState } from './state.js';
import { getCheckpointSaver } from './checkpointer.js';
import { answerNode } from './nodes/answer.js';
import { planNode } from './nodes/plan.js';
import { prepareNode } from './nodes/prepare.js';
import { pickNextToolCall, toolsNode } from './nodes/tools.js';

/**
 * 图的组装 —— **本项目要的是图的可控性**
 * （见 [03-b §B.5](../docs/03-b-技术栈-后端栈.md)）。
 *
 * ```
 *   用户输入 ──► prepare ──► plan ──┬──► tools ──► plan ──► …
 *                                   └──► answer ──► END
 * ```
 *
 * ⚠️ **不用 `createReactAgent` / `AgentExecutor`** ——
 * 预制 Agent 的中断点与循环上限不可控，而这两样正是本项目的核心。
 *
 * 📌 **循环上限在路由里判**（`MAX_TOOL_STEPS`）——
 * 超过就直接进 `answer`，不让模型继续烧预算。
 */

/** 路由需要的状态片段 */
interface RouteState {
  messages: Parameters<typeof pickNextToolCall>[0]['messages'];
  executedToolCalls: string[];
  steps: number;
  haltReason: string | null;
}

/**
 * `plan` 之后 —— **要工具还是直接答？**
 *
 * ⚠️ **模型返回了 tool_call 就走工具** —— 判定交给模型，不做关键词匹配。
 */
export function routeAfterPlan(state: RouteState): 'tools' | 'answer' {
  if (state.haltReason) return 'answer';
  return pickNextToolCall(state) ? 'tools' : 'answer';
}

/**
 * `tools` 之后 —— **继续调工具、回去问模型、还是收尾？**
 *
 * ⚠️ **一批工具调用全部执行完才回 `plan`** ——
 * 模型每发一个 `tool_use`，API 就要求配一个 `tool_result`；
 * 剩下的调用不执行，模型会看到「有调用没结果」。
 */
export function routeAfterTools(state: RouteState): 'tools' | 'plan' | 'answer' {
  if (state.haltReason) return 'answer';
  // ⚠️ **步数上限** —— 超了直接收尾
  if ((state.steps ?? 0) >= config.MAX_TOOL_STEPS) return 'answer';
  return pickNextToolCall(state) ? 'tools' : 'plan';
}

let compiled: ReturnType<typeof createGraph> | undefined;

/**
 * 建图（**带 checkpointer —— 挂起状态要能落盘**）。
 *
 * 📌 **导出来是为了能测「重启」** —— 重新建一张图 =
 * 新的 checkpointer 实例 = 进程重启后的状态（检查点从库里读）。
 */
export function createGraph() {
  return new StateGraph(AtlasState)
    .addNode('prepare', prepareNode)
    .addNode('plan', planNode)
    .addNode('tools', toolsNode)
    .addNode('answer', answerNode)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'plan')
    .addConditionalEdges('plan', routeAfterPlan, { tools: 'tools', answer: 'answer' })
    .addConditionalEdges('tools', routeAfterTools, { tools: 'tools', plan: 'plan', answer: 'answer' })
    .addEdge('answer', END)
    .compile({ checkpointer: getCheckpointSaver() });
}

/** 编译好的图（**进程内一份**） */
export function getGraph() {
  if (!compiled) compiled = createGraph();
  return compiled;
}
