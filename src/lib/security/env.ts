/**
 * 子进程的环境变量 —— **白名单**（见 [10 §10.5](../../docs/10-安全方案.md)）。
 *
 * ⚠️ **「不给什么」比「给什么」更重要** ——
 *    `process.env` 里有 `LLM_API_KEY` / `LLM_FALLBACK_API_KEY`……
 *    全量继承等于**把密钥交给模型写的命令**：
 *    一句 `printenv LLM_API_KEY` 就能把 key 读出来。
 *
 * 📌 **`shell` / 技能脚本 / 沙箱子进程共用这一份** ——
 *    沙箱本来就只给四个变量，这里是同一套口径。
 *
 * ⚠️ **不给 `NODE_OPTIONS` / 代理变量 / 任何 `*_KEY`** ——
 *    子进程不需要，给了就是白送。
 */
export function toolEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'zh_CN.UTF-8',
    TZ: process.env.TZ ?? 'Asia/Shanghai',
    USER: process.env.USER ?? '',
    SHELL: process.env.SHELL ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
  };
  return extra ? { ...env, ...extra } : env;
}
