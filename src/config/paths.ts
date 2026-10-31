import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * 路径解析 —— **所有相对路径的唯一基准**。
 *
 * ⚠️ **为什么必须有这个模块**：
 * 相对路径相对谁？相对 `process.cwd()` 的话，
 * 从不同目录启动（systemd / cron / IDE / `npx`）路径全错 ——
 * 数据库找不到、Skill 扫不到、记忆读不出来。
 * 所以：**本项目所有相对路径一律相对「项目根」解析**，不相对 cwd。
 *
 * **项目根的确定顺序**：
 * 1. 环境变量 `ATLAS_HOME`（显式指定；⚠️ 只能来自**真实环境变量**，
 *    不是 `.env` —— 因为 `.env` 的路径本身就要靠项目根来定位）
 * 2. 从本文件位置**向上找含 `package.json` 的目录**
 *    （源码 `src/config/paths.ts` → 上 2 层；编译后 `dist/src/config/paths.js` → 上 3 层，
 *    两种都对）
 * 3. 兜底 `process.cwd()`
 */

/** ⚠️ 向上找含 package.json 的目录 —— 项目根 */
function findProjectRoot(start: string): string {
  let dir = start;
  // 最多向上 10 层，防止死循环
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** 项目根 —— 路径的唯一基准 */
export const PROJECT_ROOT: string = (() => {
  const explicit = process.env.ATLAS_HOME;
  if (explicit && explicit.trim() !== '') return resolve(explicit.trim());
  return findProjectRoot(import.meta.dirname);
})();

/**
 * 相对路径 → 绝对路径（相对 `PROJECT_ROOT`）。
 * ⚠️ **绝对路径原样返回** —— 沙箱可以指向项目外（比如 `WORKSPACE_ROOT=/Users/me/work`）。
 */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(PROJECT_ROOT, p);
}

/** 标准目录（全部相对 `PROJECT_ROOT` 解析） */
export const DIRS = {
  data: resolvePath('data'),
  /** 提示词文件（`system.md` / `tool.md` / `memory.md` / `summary.md`）
   *  ⚠️ **在项目根，不在 `data/` 下** —— 它是「应用资产」不是运行时数据，
   *  要进 git（版本与回滚靠 git） */
  prompts: resolvePath('prompts'),
  /** 长期记忆（`MEMORY.md` / `USER.md`） */
  memory: resolvePath('data/memory'),
  /** 技能包目录 */
  skills: resolvePath('data/skills'),
  /** Agent 能碰到的目录（路径沙箱的基准） */
  workspace: resolvePath('data/workspace'),
  /** 运行日志 */
  logs: resolvePath('logs'),
  /** 备份 */
  backups: resolvePath('backups'),
} as const;

/** 标准文件 */
export const FILES = {
  /** 业务库（SQLite） */
  database: resolvePath('data/atlas.db'),
  /** 定时任务 */
  cron: resolvePath('data/cron.json'),
  /** 环境变量文件 —— ⚠️ **不读 cwd 下的** */
  env: resolvePath('.env'),
  envExample: resolvePath('.env.example'),
  /** 项目根的上下文文件 */
  agents: resolvePath('AGENTS.md'),
  soul: resolvePath('SOUL.md'),
} as const;

/**
 * 确保标准目录存在（启动时调）。
 * ⚠️ **只建目录，不建文件** —— 提示词 / 记忆 / 技能的内容由用户或 Agent 写。
 */
export function ensureDirs(): void {
  for (const dir of Object.values(DIRS)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
