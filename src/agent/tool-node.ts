import { createHash } from 'node:crypto';
import { interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { config } from '../config.js';
import { writeAudit } from '../lib/audit.js';
import { logger } from '../logger.js';
import { decideTool, disabledTools } from '../lib/security/policy.js';
import { scanInjection } from '../lib/security/injection.js';
import { maskString, maskValue } from '../lib/security/mask.js';
import { markUntrusted, truncateOutput } from '../tools/output.js';
import { getToolRegistry, type ToolRegistry } from '../tools/registry.js';
import { mcpPolicyLookup } from '../tools/mcp/manager.js';
import type { ToolDefinition } from '../tools/types.js';
import { recordToolCall } from '../services/tool-log.js';
import type { AssembledToolCall } from './tool-calls.js';

/**
 * 工具执行统一入口 —— **所有工具调用都必须走这里**
 * （见 [03-b §B.5.2](../docs/03-b-技术栈-后端栈.md) 与 [12-c C1](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **不许在图节点里直接 `await tool.invoke()`** ——
 * 那样会绕过权限闸（人工确认 interrupt 就形同虚设）。
 *
 * 📌 **一次只处理一个工具调用** —— 节点执行一次 = 一个确认点，
 * 恢复时不会把已经执行过的工具再执行一遍
 * （见 [12-b B5](../docs/12-b-需求-对话与编排.md)「恢复不是重新跑」）。
 */

/** 工具卡片（**落进 `parts`，刷新后还在**） */
export interface ToolCard {
  /** 工具调用 id */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 来源 */
  source: string;
  /** 状态 */
  status: 'running' | 'success' | 'error' | 'rejected';
  /** 入参 */
  input: unknown;
  /** 出参（**截断后的**） */
  output?: string;
  /** 错误原因（**失败要显示，不吞掉**） */
  error?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 这次调用是否经过了人工确认 */
  requiresConfirmation: boolean;
}

/** 执行结果 */
export interface ToolExecutionOutcome {
  /** 回灌给模型的文本（**已标「不可信数据」**） */
  content: string;
  /** 工具卡片 */
  card: ToolCard;
  /** 状态（**给流水用**） */
  status: 'success' | 'error' | 'rejected';
  /** 这次调用要不要人确认 */
  requiresConfirmation: boolean;
}

/** 恢复值（**用户点了批准 / 取消**） */
export interface ToolResumeValue {
  approved: boolean;
  /** 入参指纹 —— ⚠️ **参数变了就不能沿用旧的批准** */
  fingerprint?: string;
}

/** 稳定序列化（**键排序** —— 同样的入参要算出同样的指纹） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** 入参指纹（**批准只对这一组参数有效**） */
export function fingerprintOf(call: { name: string; args: unknown }): string {
  return createHash('sha256')
    .update(`${call.name}:${stableStringify(call.args)}`)
    .digest('hex')
    .slice(0, 16);
}

/** 风险说明（**确认卡片上给用户看**） */
function riskOf(tool: ToolDefinition): string {
  if (tool.riskNote) return tool.riskNote;
  if (tool.sensitivity === 'high') {
    return '这是高危操作 —— 确认后会立即执行。';
  }
  return '这个操作需要你确认后才会执行。';
}

export interface RunToolCallOptions {
  /** 要执行的工具调用 */
  call: AssembledToolCall;
  /** 会话 id（写流水用） */
  sessionId?: string | undefined;
  /** 发起这次调用的 assistant 消息 id */
  messageId?: string | undefined;
  /** 客户端断开时 abort */
  signal?: AbortSignal | undefined;
  /** 已被用户拒绝过的调用（**指纹集合**） */
  rejected?: ReadonlySet<string>;
  /**
   * 自动放行的工具（**无人值守场景** —— 定时任务里显式声明的）。
   *
   * ⚠️ **只跳过确认，不跳过硬禁** —— 被全局开关禁掉的工具照样跑不了。
   */
  autoApprove?: ReadonlySet<string>;
  /** 注册表（**测试可注入**） */
  registry?: ToolRegistry;
  /** 硬禁的工具（**如 `SHELL_ENABLED=false` 时的 `shell`**） */
  disabled?: ReadonlySet<string>;
  /**
   * 事件回调（**工具卡片状态变化**）。
   *
   * ⚠️ **「执行中」这一条要等确认通过后才发** ——
   * 挂起那一遍节点不会返回，发早了会多出一张重复的卡片。
   */
  emit?: ((card: ToolCard) => void) | undefined;
}

/**
 * 执行一个工具调用 —— **含权限闸与人工确认**。
 *
 * ⚠️ **这个函数里调 `interrupt()`** —— 必须在图节点里跑，
 * 挂起时会把图状态落盘（见 [12-b B5](../docs/12-b-需求-对话与编排.md)）。
 */
export async function runToolCall(options: RunToolCallOptions): Promise<ToolExecutionOutcome> {
  const registry = options.registry ?? getToolRegistry();
  const { call } = options;
  const fingerprint = fingerprintOf(call);
  const emit = options.emit;

  const base: ToolCard = {
    toolCallId: call.id,
    toolName: call.name,
    source: 'builtin',
    status: 'running',
    // ⚠️ **入参一律打码** —— 卡片会落库（parts），文件内容 / token 都在里面
    //    （见 [12-b B7](../docs/12-b-需求-对话与编排.md)）
    input: maskValue(call.args),
    requiresConfirmation: false,
  };

  // ── 工具不存在 ──
  const tool = registry.get(call.name);
  if (!tool) {
    const message = `工具「${call.name}」不存在 —— 可用工具：${registry.names().join('、')}`;
    await recordToolCall({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
      toolName: call.name,
      source: 'builtin',
      status: 'error',
      args: call.args,
      error: message,
    });
    options.emit?.({ ...base, status: 'error', error: message });
    return {
      content: message,
      card: { ...base, status: 'error', error: message },
      status: 'error',
      requiresConfirmation: false,
    };
  }

  const card: ToolCard = { ...base, source: tool.source };
  const finish = (outcome: ToolExecutionOutcome): ToolExecutionOutcome => {
    emit?.(outcome.card);
    return outcome;
  };

  // ── 用户拒绝过 → 不再问第三次 ──
  if (options.rejected?.has(fingerprint)) {
    const message = `用户已经拒绝过这个操作（${tool.name}），不要再请求。`;
    await recordToolCall({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
      toolName: tool.name,
      source: tool.source,
      status: 'rejected',
      args: call.args,
      error: message,
      requiresConfirmation: true,
    });
    return finish({
      content: message,
      card: { ...card, status: 'rejected', error: message, requiresConfirmation: true },
      status: 'rejected',
      requiresConfirmation: true,
    });
  }

  // ── 权限闸 ──
  const decision = decideTool(tool, {
    env: config,
    disabled: options.disabled ?? disabledTools(config),
    // 📌 **MCP server 粒度策略** —— 第三方来源默认 `ask`（见 [12-c C5](../docs/12-c-需求-工具技能与扩展.md)）
    mcpPolicy: mcpPolicyLookup,
  });

  if (decision.decision === 'blocked' || decision.decision === 'reject') {
    const message = `工具「${tool.name}」被安全策略拦截：${decision.reason}`;
    await recordToolCall({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
      toolName: tool.name,
      source: tool.source,
      status: 'rejected',
      args: call.args,
      error: message,
    });
    await writeAudit('TOOL_BLOCKED', 'tool', tool.name, {
      sessionId: options.sessionId,
      reason: decision.reason,
    });
    return finish({
      content: message,
      card: { ...card, status: 'rejected', error: message },
      status: 'rejected',
      requiresConfirmation: false,
    });
  }

  // ── 人工确认闸 ──
  let requiresConfirmation = false;
  // 📌 **自动放行名单**（无人值守场景 —— 定时任务显式声明的）
  //    ⚠️ **只放行「await」** —— 被硬禁（blocked）的不受影响
  const autoApproved = options.autoApprove?.has(tool.name) === true;
  if (decision.decision === 'await' && autoApproved) {
    logger.info(
      { tool: tool.name, sessionId: options.sessionId },
      '工具在自动放行名单里 —— 跳过人工确认',
    );
    await writeAudit('TOOL_AUTO_APPROVED', 'tool', tool.name, {
      sessionId: options.sessionId,
      toolCallId: call.id,
    });
  } else if (decision.decision === 'await') {
    requiresConfirmation = true;
    const payload = {
      toolCallId: call.id,
      toolName: tool.name,
      args: call.args,
      risk: riskOf(tool),
      fingerprint,
    };

    // ⚠️ **这里挂起** —— 图状态落盘，进程重启后待确认仍在
    const resume = interrupt<typeof payload, ToolResumeValue | undefined>(payload);

    if (!resume || resume.approved !== true) {
      const message = '用户拒绝了这个操作。';
      await recordToolCall({
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.messageId ? { messageId: options.messageId } : {}),
        toolName: tool.name,
        source: tool.source,
        status: 'rejected',
        args: call.args,
        error: message,
        requiresConfirmation: true,
      });
      await writeAudit('TOOL_REJECTED', 'tool', tool.name, {
        sessionId: options.sessionId,
        toolCallId: call.id,
      });
      return finish({
        content: `${message}不要再请求这个操作。`,
        card: { ...card, status: 'rejected', error: message, requiresConfirmation: true },
        status: 'rejected',
        requiresConfirmation: true,
      });
    }

    // ⚠️ **参数变了 → 重新确认** —— 不能沿用旧的批准
    if (resume.fingerprint && resume.fingerprint !== fingerprint) {
      interrupt({ ...payload, risk: `${riskOf(tool)}（参数已变化，需要重新确认）` });
    }
  }

  // ── 真正执行 ──
  // ⚠️ **「执行中」卡片在这里才发** —— 挂起那一遍还没走到这儿，
  //    提前发会多出一张重复的卡片
  emit?.({ ...card, status: 'running' });

  const started = Date.now();
  let result: Awaited<ReturnType<ToolDefinition['invoke']>>;
  try {
    result = await tool.invoke(call.args, {
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      // 📌 **带上调用 id** —— 子代理靠它算稳定的 thread_id
      toolCallId: call.id,
    });
  } catch (err) {
    // ⚠️ **图中断不能吞** —— 它是「挂起等确认」的机制。
    //    子代理要人工确认时，中断会一路冒泡到父图（见 [12-b B10](../docs/12-b-需求-对话与编排.md)）；
    //    吞掉就等于「子代理绕过确认」。
    if (isGraphInterrupt(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - started;
    await recordToolCall({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
      toolName: tool.name,
      source: tool.source,
      status: 'error',
      args: call.args,
      error: message,
      durationMs: duration,
      requiresConfirmation,
    });
    await writeAudit('TOOL_FAILED', 'tool', tool.name, {
      sessionId: options.sessionId,
      toolCallId: call.id,
      error: message,
    });
    return finish({
      content: `工具「${tool.name}」执行失败：${message}。可以换个思路继续。`,
      card: { ...card, status: 'error', error: message, durationMs: duration, requiresConfirmation },
      status: 'error',
      requiresConfirmation,
    });
  }

  const duration = Date.now() - started;
  // ⚠️ **工具能自报「别截我」** —— 比如读项目指令文件：
  //    全局截断（保留尾部）会把文件头切掉，模型读到的是半截
  const clipped =
    result.truncate === false
      ? { text: result.output, truncated: false, originalLength: result.output.length }
      : truncateOutput(result.output);
  const ok = result.ok;

  // ⚠️ **工具结果过注入检测** —— 命中只告警 + 收紧，不直接拒答
  //    （见 [10 §10.7](../docs/10-安全方案.md)）
  const scan = scanInjection(result.output);
  if (scan.detected) {
    logger.warn(
      { tool: tool.name, matches: scan.matches },
      '工具结果里出现疑似提示词注入 —— 已标记为不可信数据',
    );
    await writeAudit('TOOL_BLOCKED', 'tool', tool.name, {
      sessionId: options.sessionId,
      toolCallId: call.id,
      reason: `工具结果疑似注入：${scan.matches.join('、')}`,
    });
  }

  await recordToolCall({
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    toolName: tool.name,
    source: tool.source,
    status: ok ? 'success' : 'error',
    args: call.args,
    output: result.data ?? result.output,
    ...(result.error ? { error: result.error } : {}),
    durationMs: duration,
    requiresConfirmation,
  });
  await writeAudit(ok ? 'TOOL_EXECUTED' : 'TOOL_FAILED', 'tool', tool.name, {
    sessionId: options.sessionId,
    toolCallId: call.id,
    durationMs: duration,
  });
  if (requiresConfirmation) {
    await writeAudit('TOOL_APPROVED', 'tool', tool.name, {
      sessionId: options.sessionId,
      toolCallId: call.id,
    });
  }

  return finish({
    content: markUntrusted(clipped.text, tool.name),
    card: {
      ...card,
      status: ok ? 'success' : 'error',
      // ⚠️ **出参也要打码** —— 文件内容、token 都在里面
      //    （见 [12-b B7](../docs/12-b-需求-对话与编排.md)）
      output: maskString(clipped.text),
      ...(result.error ? { error: result.error } : {}),
      durationMs: duration,
      requiresConfirmation,
    },
    status: ok ? 'success' : 'error',
    requiresConfirmation,
  });
}
