import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { z } from 'zod';
import { config } from '../../config.js';
import { paths } from '../../config.js';
import { matchBlacklist } from '../../lib/security/blacklist.js';
import { parseArgs, schemas } from '../args.js';
import { truncateOutput } from '../output.js';
import type { ToolDefinition, ToolResult } from '../types.js';

/**
 * `shell` —— 执行命令（**高危档，默认要确认**）。
 *
 * ⚠️ **三个特殊处理**（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）：
 * ① 超时（默认 30 秒）→ 杀掉进程并返回超时错误
 * ② 输出截断（默认 4000 字符）→ **保留尾部**（错误信息通常在尾部）并标注原始长度
 * ③ Windows 用 `cmd /c`，Unix 用 `/bin/sh -c` —— **命令构造要跨平台**
 *
 * ⚠️ **命令黑名单是兜底不是主防线** —— 主防线是「默认要确认」
 * （见 [12-c C3](../docs/12-c-需求-工具技能与扩展.md)）。
 */

/** shell 命令 */
const shellSchema = z.object({
  command: schemas.text(4000),
  /** 工作目录（**默认工作区根**；必须在工作区内） */
  cwd: schemas.path.optional(),
  /** 超时（毫秒，默认取 `TOOL_TIMEOUT_MS`） */
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});

export const shellTool: ToolDefinition = {
  name: 'shell',
  description:
    '在工作区里执行一条 shell 命令（Unix 用 /bin/sh，Windows 用 cmd）。' +
    '工作目录固定在工作区内。命令有危险黑名单，命中会被直接拒绝。' +
    '输出过长会截断（保留尾部）。',
  schema: shellSchema,
  sensitivity: 'high',
  source: 'builtin',
  enabled: true,
  executor: 'subagent',
  async invoke(args): Promise<ToolResult> {
    const input = parseArgs(shellSchema, args);
    const command = input.command;

    // ⚠️ **黑名单直接拒** —— 不给确认的机会
    const hit = matchBlacklist(command);
    if (hit) {
      const message = `命令命中安全黑名单（${hit.name}：${hit.reason}），已拒绝执行`;
      return { ok: false, output: message, error: `COMMAND_BLOCKED: ${message}` };
    }

    const cwd = input.cwd
      ? input.cwd.startsWith('/')
        ? input.cwd
        : `${paths.workspaceRoot}/${input.cwd}`
      : paths.workspaceRoot;
    const timeoutMs = input.timeoutMs ?? config.TOOL_TIMEOUT_MS;
    const isWindows = platform() === 'win32';

    const started = Date.now();
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      spawnError?: string;
    }>((resolve) => {
      const child = spawn(isWindows ? 'cmd' : '/bin/sh', isWindows ? ['/c', command] : ['-c', command], {
        cwd,
        env: { ...process.env, ATLAS_SHELL: '1' },
        // ⚠️ **不给 stdin** —— 命令别等输入
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // ⚠️ **超时强杀** —— 不杀掉的话进程会一直挂着
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedOut, spawnError: err.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });

    const duration = Date.now() - started;

    if (result.spawnError) {
      return {
        ok: false,
        output: `命令启动失败：${result.spawnError}`,
        error: `SPAWN_FAILED: ${result.spawnError}`,
      };
    }
    if (result.timedOut) {
      return {
        ok: false,
        output: `命令超时（${timeoutMs}ms），已杀掉`,
        error: `TIMEOUT: 命令超时（${timeoutMs}ms）`,
      };
    }

    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const clipped = truncateOutput(combined, config.TOOL_OUTPUT_MAX_CHARS, 'tail');
    const exitCode = result.code ?? 0;
    const header = `退出码：${exitCode}（耗时 ${duration}ms）\n`;

    if (exitCode !== 0) {
      return {
        ok: false,
        output: `${header}${clipped.text}`,
        error: `EXIT_CODE_${exitCode}`,
        data: { exitCode, durationMs: duration, cwd },
        truncated: clipped.truncated,
        originalLength: clipped.originalLength,
      };
    }

    return {
      ok: true,
      output: `${header}${clipped.text || '(没有输出)'}`,
      data: { exitCode, durationMs: duration, cwd },
      truncated: clipped.truncated,
      originalLength: clipped.originalLength,
    };
  },
};

/** 执行类工具 */
export const shellTools: ToolDefinition[] = [shellTool];
