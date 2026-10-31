#!/usr/bin/env node
/**
 * 沙箱代码执行器 —— **`execute_code` 的子进程**（见 [12-c C2](../../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **这个文件是纯 JS，不参与 TypeScript 编译** ——
 *    它要被 `node` 直接跑（`dist/` 里没有它）。
 *
 * ## 协议（NDJSON，走 stdin / stdout）
 *
 * ```
 * 父 → 子：{"t":"code","code":"..."}      第一条 —— 要跑的脚本
 * 子 → 父：{"t":"rpc","id":1,"tool":"read_file","args":{...}}
 * 父 → 子：{"id":1,"ok":true,"text":"..."}   RPC 回应
 * 子 → 父：{"t":"log","text":"..."}        脚本的 console 输出
 * 子 → 父：{"t":"done","ok":true,"value":...,"logs":"..."}
 * ```
 *
 * ## 沙箱边界（**防手滑，不是防投毒**）
 *
 * - 用户代码跑在 `vm` 的**独立上下文**里 —— 只有 ECMAScript 内建对象，
 *   **没有 `require` / `process` / `fetch` / `Buffer`**
 * - 想碰文件与网络，**只能通过 `atlas.call()` 走父进程** —— 父进程逐个过权限闸
 * - 父进程还有一道超时 —— 超时直接杀进程
 *
 * ⚠️ **这不是针对恶意代码的强隔离**（Node 的 `vm` 从来不是）——
 *    它防的是「模型手滑写出破坏性脚本」。
 */

import { createInterface } from 'node:readline';
import vm from 'node:vm';

/** 日志条数上限（**防刷屏**） */
const MAX_LOG_LINES = 500;

/** 脚本返回值序列化（**处理函数 / bigint / 循环引用**） */
function serialize(value) {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'symbol') return item.toString();
      return item;
    });
    return json === undefined ? null : json;
  } catch {
    return String(value);
  }
}

/** 待回应的 RPC（**id → 回调**） */
const pending = new Map();

/** 下一个 RPC id */
let nextId = 1;

/** 往父进程发一条消息（**stdout 只走协议**） */
function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** 脚本的日志 */
const logLines = [];

/** 记一条日志（**同时发给父进程**） */
function log(text) {
  const line = String(text);
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  send({ t: 'log', text: line });
}

/** 格式化 console 的参数 */
function format(args) {
  return args
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item instanceof Error) return item.stack ?? item.message;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(' ');
}

/** 父进程 → 子进程：RPC 回应 */
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.t === 'code') {
    void run(message.code ?? '');
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.text ?? '');
  else waiter.reject(new Error(message.error || '工具调用失败'));
});

/**
 * 调父进程里的工具。
 *
 * ⚠️ **只有父进程能真正执行工具** —— 脚本本身碰不到文件与网络。
 */
function call(tool, args) {
  const id = nextId;
  nextId += 1;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  send({ t: 'rpc', id, tool: String(tool), args: args ?? {} });
  return promise;
}

/**
 * 用户脚本能看到的全局。
 *
 * ⚠️ **必须是「无原型」的对象** —— 有原型的话 `globalThis.constructor.constructor`
 *    拿到的是**宿主**的 `Function`，脚本就能
 *    `this.constructor.constructor('return process')()` 逃出沙箱
 *    （`vm` 的经典漏洞，实测能拿到宿主的 `process`）。
 */
const sandbox = Object.create(null);

/**
 * @param {string} tool
 * @param {unknown} args
 * @returns {Promise<string>}
 */
sandbox.atlas = {
  call: (tool, args) => call(tool, args),
  log: (...args) => log(format(args)),
};
sandbox.console = {
  log: (...args) => log(format(args)),
  info: (...args) => log(format(args)),
  warn: (...args) => log(format(args)),
  error: (...args) => log(format(args)),
  debug: (...args) => log(format(args)),
};
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setInterval = setInterval;
sandbox.clearInterval = clearInterval;

/** 跑用户脚本 */
async function run(code) {
  const started = Date.now();
  let ok = true;
  let value = null;
  let error = null;

  try {
    // ⚠️ **禁掉「字符串生成代码」** —— 不禁的话脚本能靠
    //    `this.constructor.constructor('return process')()` 逃出沙箱
    //    （`vm` 的经典漏洞：`context.constructor` 指着**宿主**的 `Object`）
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    // 📌 **包一层 async IIFE** —— 这样用户代码可以写顶层 `await`
    const wrapped = `(async () => {\n${code}\n})()`;
    const result = await vm.runInContext(wrapped, context, {
      timeout: 10_000,
      filename: 'atlas-sandbox.js',
    });
    value = serialize(result);
  } catch (err) {
    ok = false;
    error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  }

  send({
    t: 'done',
    ok,
    value,
    error,
    logs: logLines.join('\n'),
    durationMs: Date.now() - started,
  });
  // ⚠️ **跑完就退** —— 别让残留的定时器把进程吊着
  process.exit(ok ? 0 : 1);
}

/** 兜底：脚本里的未捕获异常 */
process.on('unhandledRejection', (reason) => {
  send({
    t: 'done',
    ok: false,
    value: null,
    error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    logs: logLines.join('\n'),
    durationMs: 0,
  });
  process.exit(1);
});
