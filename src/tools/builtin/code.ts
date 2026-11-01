import { nanoid } from 'nanoid';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { config, paths } from '../../config.js';
import { logger } from '../../logger.js';
import { decideTool, disabledTools } from '../../lib/security/policy.js';
import type { InjectionScan } from '../../lib/security/injection.js';
import { mcpPolicyLookup } from '../mcp/manager.js';
import { parseArgs, schemas } from '../args.js';
import { truncateOutput } from '../output.js';
import { getToolRegistry } from '../registry.js';
import { runSandboxScript, type SandboxRpcResult } from '../sandbox/session.js';
import type { ToolDefinition, ToolResult } from '../types.js';
import { runToolCall } from '../../agent/tool-node.js';

/**
 * `execute_code` —— **沙箱里跑脚本**（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 🎯 **这是 Hermes 的招牌能力** —— 模型写一段 JavaScript，
 * 脚本里通过 `atlas.call()` 调别的工具，
 * **中间结果不进对话上下文**，只把最终输出带回来 ——
 * 一次推理就能完成多步管线。
 *
 * ```
 * const a = await atlas.call('http_request', { url: 'https://example.com/a' });
 * const b = await atlas.call('http_request', { url: 'https://example.com/b' });
 * return { a: a.length, b: b.length };
 * ```
 *
 * ⚠️ **沙箱里不能调需要确认的工具** —— `shell` / `write_file` / `delete_path`
 * 这类必须在主对话里直接调（**各走各的确认闸**）。
 * 理由很直接：批准一次「跑脚本」等于批准脚本里的所有危险动作，
 * 那确认闸就形同虚设了。
 */

/** 脚本长度上限（**字符**） */
const MAX_CODE_CHARS = 50_000;

/** 默认超时（**毫秒**） */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 超时上限（**别让模型申请跑一天**） */
const MAX_TIMEOUT_MS = 300_000;

const codeSchema = z.object({
  /** 要跑的 JavaScript */
  code: schemas.text(MAX_CODE_CHARS),
  /** 超时（毫秒，默认 120 秒） */
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

/**
 * 沙箱里的一次 RPC —— **父进程去执行真正的工具**。
 *
 * ⚠️ **权限闸照走** —— 判成「要确认」的一律拒绝：
 * 沙箱里没有「谁来点批准」这回事，放行等于绕过确认闸。
 */
async function handleRpc(
  toolName: string,
  args: unknown,
  context: {
    sessionId?: string | undefined;
    messageId?: string | undefined;
    signal?: AbortSignal | undefined;
    injectionMatches?: string[] | undefined;
  },
): Promise<SandboxRpcResult> {
  const registry = getToolRegistry();
  const tool = registry.get(toolName);
  if (!tool) {
    return {
      ok: false,
      text: '',
      error: `工具「${toolName}」不存在 —— 可用工具：${registry.names().join('、')}`,
    };
  }

  // ⚠️ **不能递归调自己** —— 会无限套娃
  if (tool.name === 'execute_code') {
    return { ok: false, text: '', error: '沙箱里不能再调 execute_code' };
  }

  // 📌 **注入命中 → 升档** —— 沙箱里的调用要在**自己的闸**上再判一次
  //    （不传的话，「注入命中 → 工具档位收紧」在沙箱这条路上是空的 ——
  //    见 [10 §10.7](../../docs/10-安全方案.md)）
  const injection: InjectionScan = {
    detected: (context.injectionMatches?.length ?? 0) > 0,
    matches: context.injectionMatches ?? [],
  };

  const decision = decideTool(tool, {
    env: config,
    disabled: disabledTools(config),
    mcpPolicy: mcpPolicyLookup,
    // 📌 **入参传进去** —— 命令黑名单在策略层判（见 [12-c C3](../docs/12-c-需求-工具技能与扩展.md)）
    args: args ?? {},
    injection,
  });
  if (decision.decision !== 'allow') {
    return {
      ok: false,
      text: '',
      error:
        `沙箱里不能调用「${tool.name}」—— ${decision.reason}。` +
        '需要确认的工具请在主对话里直接调用。',
    };
  }

  // 📌 **走统一入口** —— 权限闸、脱敏、流水一个都不少
  //    （见 [12-c C1](../docs/12-c-需求-工具技能与扩展.md)）
  const outcome = await runToolCall({
    call: {
      id: nanoid(),
      name: tool.name,
      type: 'tool_call',
      args: (args ?? {}) as Record<string, unknown>,
    },
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    // 📌 **消息 id 加后缀** —— 流水里一眼看出这是脚本里调的
    ...(context.messageId ? { messageId: `${context.messageId}#exec` } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    // 📌 **注入命中的特征要传下去** —— 统一入口那层也要升档
    ...(injection.detected ? { injection } : {}),
    // ⚠️ **不发卡片** —— 中间步骤只在流水里，不进对话
  });

  return {
    ok: outcome.status === 'success',
    text: outcome.card.output ?? '',
    ...(outcome.card.error ? { error: outcome.card.error } : {}),
  };
}

export const executeCodeTool: ToolDefinition = {
  name: 'execute_code',
  description:
    '在受限沙箱里跑一段 JavaScript。脚本里可以用 `await atlas.call(工具名, 参数)` 调用别的工具' +
    '（比如 http_request / read_file），**中间结果不会进对话上下文**，只把脚本的返回值带回来 —— ' +
    '适合「一次推理做完多步管线」。沙箱里没有网络与文件系统，' +
    '需要确认的工具（shell / 写文件 / 删除）请在主对话里直接调用。',
  schema: codeSchema,
  sensitivity: 'high',
  keywords: ['沙箱', '脚本', '代码执行', 'javascript', '管线', '多步', '算一下', '计算'],
  riskNote:
    '会在受限子进程里执行你给的 JavaScript。脚本能通过 atlas.call() 调用其它工具' +
    '（但调不到需要确认的那些）。',
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  async invoke(args: unknown, context): Promise<ToolResult> {
    const input = parseArgs(codeSchema, args);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 📌 **项目根必须存在** —— 子进程的 cwd 不存在就起不来
    mkdirSync(paths.workspaceRoot, { recursive: true });

    const result = await runSandboxScript({
      code: input.code,
      // 📌 **cwd 是项目根** —— 脚本里的相对路径从项目根算
      cwd: paths.workspaceRoot,
      timeoutMs,
      onRpc: (tool, rpcArgs) => handleRpc(tool, rpcArgs, context),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    if (!result.ok) {
      return {
        ok: false,
        output: `沙箱执行失败：${result.error ?? '未知原因'}`,
        error: result.error,
        data: {
          durationMs: result.durationMs,
          rpcCalls: result.rpcCalls,
        },
      };
    }

    const clipped = truncateOutput(result.output);
    logger.info({ rpcCalls: result.rpcCalls, durationMs: result.durationMs }, '沙箱脚本跑完了');

    return {
      ok: true,
      output: clipped.text || '（脚本没有输出）',
      data: {
        durationMs: result.durationMs,
        rpcCalls: result.rpcCalls,
        logs: result.logs,
      },
      ...(clipped.truncated ? { truncated: true, originalLength: clipped.originalLength } : {}),
    };
  },
};

/** 沙箱工具组 */
export function sandboxToolGroups(): Array<{ source: 'builtin'; tools: ToolDefinition[] }> {
  return [{ source: 'builtin', tools: [executeCodeTool] }];
}
