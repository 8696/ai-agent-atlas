import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePath } from '../../config/paths.js';
import { logger } from '../../logger.js';

/**
 * 沙箱会话 —— **父进程这一侧**（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **父进程才是真正干活的人** —— 脚本里的 `atlas.call()` 一路回到这里，
 * 由这里去调真正的工具（**权限闸照走**）。
 *
 * ⚠️ **子进程给不了权限** —— 沙箱里能调哪些工具由父进程说了算，
 * 沙箱自己说了不算（见 `builtin/code.ts`）。
 */

/**
 * 沙箱执行器（**纯 JS，不参与编译**）的路径。
 *
 * ⚠️ **两个候选位置** ——
 * ① 项目根的 `assets/sandbox/runner.mjs`（**生产环境走这条**）；
 * ② 本文件上溯三级的同名文件（**源码布局** ——
 *    `ATLAS_HOME` 指向别处时项目根里没有 `assets/`，比如集成测试）。
 */
function resolveRunnerPath(): string {
  const candidates = [
    resolvePath('assets/sandbox/runner.mjs'),
    resolve(import.meta.dirname, '../../../assets/sandbox/runner.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] as string;
}

/** 沙箱执行器路径（**懒解析** —— 测试里换 `ATLAS_HOME` 也能找到） */
let runnerPath: string | undefined;

/** 取沙箱执行器路径 */
export function sandboxRunnerPath(): string {
  if (!runnerPath) runnerPath = resolveRunnerPath();
  return runnerPath;
}

/** RPC 的一次调用结果 */
export interface SandboxRpcResult {
  ok: boolean;
  /** 给脚本看的正文 */
  text: string;
  /** 失败原因 */
  error?: string | undefined;
}

/** 沙箱跑完的结果 */
export interface SandboxRunResult {
  /** 脚本有没有正常跑完 */
  ok: boolean;
  /** 给模型看的正文（**脚本返回值 + 日志**） */
  output: string;
  /** 脚本日志 */
  logs: string;
  /** 失败原因 */
  error?: string | undefined;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 脚本里调了几次工具 */
  rpcCalls: number;
}

export interface SandboxRunOptions {
  /** 要跑的 JavaScript */
  code: string;
  /** 工作目录（**沙箱内看到的 cwd**） */
  cwd: string;
  /** 超时（毫秒）—— 超了直接杀进程 */
  timeoutMs: number;
  /** RPC 处理器 —— 父进程执行工具 */
  onRpc: (tool: string, args: unknown) => Promise<SandboxRpcResult>;
  /** 客户端断开时 abort */
  signal?: AbortSignal | undefined;
}

/** 把协议里的字段摊成字符串（**别用默认的 `[object Object]`**） */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** 给子进程的环境（**只留最少的**） */
function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'zh_CN.UTF-8',
    TZ: process.env.TZ ?? 'Asia/Shanghai',
    NODE_ENV: 'development',
    // ⚠️ **不给 NODE_OPTIONS / 代理变量 / 任何 API Key** ——
    //    子进程不需要，给了就是白送
  };
}

/**
 * 在沙箱里跑一段脚本。
 *
 * ⚠️ **超时 = 杀进程** —— 脚本死循环 / 卡住都不会拖住主流程。
 */
export async function runSandboxScript(options: SandboxRunOptions): Promise<SandboxRunResult> {
  const started = Date.now();

  const child = spawn(process.execPath, ['--no-warnings', sandboxRunnerPath()], {
    cwd: options.cwd,
    env: sandboxEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    // ⚠️ **不继承进程组** —— 脚本起的东西不许活到主进程之外
    detached: false,
  });

  let rpcCalls = 0;
  let logs = '';
  let settled = false;
  let resolveResult: (result: SandboxRunResult) => void = () => {};

  const finished = new Promise<SandboxRunResult>((resolve) => {
    resolveResult = resolve;
  });

  /** 结束并返回 */
  const settle = (result: SandboxRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    resolveResult(result);
  };

  /** 超时杀进程 */
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    settle({
      ok: false,
      output: '',
      logs,
      error: `沙箱执行超时（${options.timeoutMs}ms）—— 进程已被杀掉`,
      durationMs: Date.now() - started,
      rpcCalls,
    });
  }, options.timeoutMs);
  timer.unref?.();

  /** 客户端断开 */
  const onAbort = (): void => {
    child.kill('SIGKILL');
    settle({
      ok: false,
      output: '',
      logs,
      error: '用户中断了这次执行',
      durationMs: Date.now() - started,
      rpcCalls,
    });
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  // ── stderr：只是日志，出错时带上 ──
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  // ⚠️ **stdin 的错误必须吃掉** —— 子进程已经退出时再写 RPC 回应，
  //    Node 会抛 `EPIPE`（未处理的 'error' 事件 = 整个进程崩掉）
  child.stdin?.on('error', () => {
    // 子进程没了 —— 下面的 'close' 分支会给出错误
  });

  // ── stdout：协议 ──
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.t === 'log') {
      logs += `${asText(message.text)}\n`;
      return;
    }

    if (message.t === 'rpc') {
      const id = message.id as number;
      const tool = asText(message.tool);
      const args = message.args;
      rpcCalls += 1;
      void options
        .onRpc(tool, args)
        .then((result) => {
          child.stdin?.write(
            `${JSON.stringify({
              id,
              ok: result.ok,
              text: result.text,
              error: result.error,
            })}\n`,
          );
        })
        .catch((err: unknown) => {
          child.stdin?.write(
            `${JSON.stringify({
              id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })}\n`,
          );
        });
      return;
    }

    if (message.t === 'done') {
      const ok = message.ok === true;
      const value = asText(message.value);
      const error = message.error ? asText(message.error) : undefined;
      const scriptLogs = typeof message.logs === 'string' ? message.logs : logs;
      settle({
        ok,
        output: [value, scriptLogs].filter(Boolean).join('\n'),
        logs: scriptLogs,
        ...(error ? { error } : {}),
        durationMs: Date.now() - started,
        rpcCalls,
      });
    }
  });

  // ── 子进程自己退了（还没发 done） ──
  child.on('close', (code) => {
    if (settled) return;
    settle({
      ok: false,
      output: '',
      logs,
      error:
        stderr.trim() ||
        `沙箱进程提前退出（退出码 ${code ?? '未知'}）—— 可能是脚本把进程搞崩了`,
      durationMs: Date.now() - started,
      rpcCalls,
    });
  });

  child.on('error', (err) => {
    if (settled) return;
    settle({
      ok: false,
      output: '',
      logs,
      error: `沙箱起不来：${err.message}`,
      durationMs: Date.now() - started,
      rpcCalls,
    });
  });

  // ── 把脚本送进去 ──
  child.stdin?.write(`${JSON.stringify({ t: 'code', code: options.code })}\n`);

  logger.debug({ rpcCalls }, '沙箱脚本已启动');
  return finished;
}
