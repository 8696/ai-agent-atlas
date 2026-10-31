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
 *
 * ## ⚠️ **宿主能力为什么不直接挂上去**（这一段是安全的核心）
 *
 * `vm` 的 `codeGeneration.strings = false` **只约束上下文自己 realm 的
 * `Function`** —— 它管不到从宿主传进来的对象。
 *
 * 所以下面这种写法是**漏的**：
 *
 * ```js
 * sandbox.atlas = { call: (tool, args) => call(tool, args) };  // ❌ 宿主函数
 * ```
 *
 * 脚本只要写 `atlas.call.constructor('return process')()`，
 * 拿到的就是**宿主的 `Function`**（宿主对象的原型链直通宿主 `Function.prototype`，
 * 不受上下文开关约束）→ 沙箱逃逸 → 能读任意文件、能执行任意命令。
 *
 * ✅ **正确做法**：宿主能力**只作为参数进入闭包**，
 * 暴露给脚本的包装函数**全部在上下文 realm 里创建**。
 * 这样脚本拿到的 `.constructor` 是**上下文的 `Function`** → 被 `codeGeneration` 挡住。
 *
 * 📌 **同理要处理的三处**：
 * ① 返回值要**深拷贝**（宿主对象不能直接流回脚本）
 * ② 抛出的异常要**在上下文里重建**（宿主 `Error` 的 `.constructor` 也是宿主 `Function`）
 * ③ 定时器句柄要**换成数字**（宿主 `Timeout` 对象同样会漏出去）
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
 * ⚠️ **在上下文 realm 里创建的引导代码** ——
 *    暴露给脚本的每个函数**都是上下文的函数**，
 *    它们的 `.constructor` 是**上下文的 `Function`**，
 *    于是 `atlas.call.constructor('return process')()` 会被
 *    `codeGeneration.strings = false` 挡住。
 *
 * ⚠️ **宿主实现只作为参数进入闭包** —— 脚本拿不到 `impl`：
 *    它既不在任何全局上，也不在返回对象的属性里。
 *
 * 📌 **三处必须一起处理**（任一漏了都能漏出宿主对象）：
 * ① 返回值**深拷贝**（宿主对象不能直接流回脚本）
 * ② 异常**在上下文里重建**（宿主 `Error` 的 `.constructor` 也是宿主 `Function`）
 * ③ 定时器句柄**换成数字**（宿主 `Timeout` 对象同样会漏出去）
 */
const BOOTSTRAP = `
(function (impl) {
  'use strict';

  /** 深拷贝 —— 宿主对象不能直接流回脚本 */
  function clone(value, depth) {
    if (depth > 6) return null;
    if (value === null || typeof value !== 'object') {
      // ⚠️ **函数不拷** —— 宿主函数带过去等于把宿主 Function 送出去
      return typeof value === 'function' ? undefined : value;
    }
    if (Array.isArray(value)) {
      return value.map(function (item) { return clone(item, depth + 1); });
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key], depth + 1);
    return out;
  }

  /** 宿主异常 → 上下文异常（宿主的 Error 同样会漏出去） */
  function toError(err) {
    const message =
      err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
    return new Error(message);
  }

  globalThis.atlas = {
    call: function (tool, args) {
      // ⚠️ **不用 async function** —— AsyncFunction 的字符串构造器
      //    是否被 codeGeneration 挡住没有保证，普通函数是确定的
      return Promise.resolve()
        .then(function () { return impl.call(tool, args); })
        .then(
          function (text) { return clone(text, 0); },
          function (err) { throw toError(err); },
        );
    },
    log: function (parts) { impl.log(parts); },
  };

  const write = function (parts) { impl.log(parts); };
  globalThis.console = {
    log: write,
    info: write,
    warn: write,
    error: write,
    debug: write,
  };

  // ⚠️ **句柄换成数字** —— 宿主 Timeout 对象带出去就是宿主对象
  globalThis.setTimeout = function (fn, ms) { return impl.setTimeout(fn, ms); };
  globalThis.clearTimeout = function (id) { impl.clearTimeout(id); };
  globalThis.setInterval = function (fn, ms) { return impl.setInterval(fn, ms); };
  globalThis.clearInterval = function (id) { impl.clearInterval(id); };
})
`;

/**
 * 定时器句柄 —— **宿主侧维护**（脚本只拿到数字 id）。
 */
const timerHandles = new Map();
let timerSeq = 1;

/**
 * 宿主能力 —— **只进闭包，不进脚本可见的全局**。
 */
const impl = {
  /**
   * 调父进程里的工具。
   *
   * @param {string} tool
   * @param {unknown} args
   * @returns {Promise<string>}
   */
  call,
  /**
   * 写一条日志。
   *
   * @param {unknown[]} parts
   */
  log: (parts) => log(format(parts)),
  /**
   * 起一个定时器。
   *
   * @param {() => void} fn
   * @param {number} ms
   * @returns {number} 句柄 id（**不是宿主对象**）
   */
  setTimeout: (fn, ms) => {
    const id = timerSeq;
    timerSeq += 1;
    const handle = setTimeout(() => {
      timerHandles.delete(id);
      try {
        fn();
      } catch {
        // ⚠️ **脚本抛错就吞掉** —— 定时器回调的异常不该弄垮子进程
      }
    }, ms);
    timerHandles.set(id, handle);
    return id;
  },
  /**
   * @param {number} id
   */
  clearTimeout: (id) => {
    const handle = timerHandles.get(id);
    if (handle === undefined) return;
    clearTimeout(handle);
    timerHandles.delete(id);
  },
  /**
   * @param {() => void} fn
   * @param {number} ms
   * @returns {number} 句柄 id
   */
  setInterval: (fn, ms) => {
    const id = timerSeq;
    timerSeq += 1;
    const handle = setInterval(() => {
      try {
        fn();
      } catch {
        // ⚠️ **同上** —— 回调异常不能让进程退出
      }
    }, ms);
    timerHandles.set(id, handle);
    return id;
  },
  /**
   * @param {number} id
   */
  clearInterval: (id) => {
    const handle = timerHandles.get(id);
    if (handle === undefined) return;
    clearInterval(handle);
    timerHandles.delete(id);
  },
};

/**
 * 沙箱上下文 —— **建一次**。
 *
 * ⚠️ **禁掉「字符串生成代码」** —— 不禁的话脚本能靠
 *    `this.constructor.constructor('return process')()` 逃出沙箱
 *    （`vm` 的经典漏洞：`context.constructor` 指着**宿主**的 `Object`）
 */
const context = vm.createContext(sandbox, {
  codeGeneration: { strings: false, wasm: false },
});

// ⚠️ **在上下文 realm 里安装 API** —— 包装函数必须是上下文的函数
vm.runInContext(BOOTSTRAP, context)(impl);

/** 跑用户脚本 */
async function run(code) {
  const started = Date.now();
  let ok = true;
  let value = null;
  let error = null;

  try {
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
