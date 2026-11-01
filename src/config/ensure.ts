import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIRS, FILES } from './paths.js';
import {
  CRON_FILE_TEMPLATE,
  DEFAULT_MEMORY_PROMPT,
  DEFAULT_SKILL_PROMPT,
  DEFAULT_SOUL,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TOOL_PROMPT,
  LEGACY_MEMORY_FILE_TEMPLATE,
  LEGACY_USER_FILE_TEMPLATE,
  MEMORY_FILE_TEMPLATE,
  PRICING_FILE_TEMPLATE,
  USER_FILE_TEMPLATE,
} from '../prompts/defaults.js';

/**
 * 启动时的**文件**初始化。
 *
 * ⚠️ `ensureDirs()` 只建目录 —— 目录里该有什么文件，是这里的事。
 *
 * **两类文件，处理方式不同**：
 *
 * | 文件                                        | 在 git？ | 缺失时            |
 * | ------------------------------------------- | ------- | ----------------- |
 * | `prompts/*.md` · `SOUL.md`                  | ✅ 进    | 从**兜底模板**写回（用户可能删了） |
 * | `data/memory/MEMORY.md` · `USER.md`        | ❌ 不进  | 从**模板**新建     |
 * | `data/cron.json`                           | ❌ 不进  | 写空任务列表       |
 *
 * ⚠️ **已存在的文件一律不动** —— 哪怕是空文件（用户可能故意清空过）。
 * ⚠️ **只补缺失的，不覆盖** —— 覆盖等于丢用户数据。
 */

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, content, 'utf8');
  return true;
}

export interface EnsureResult {
  /** 本次新建的文件（相对项目根） */
  created: string[];
  /** 本次**摘掉旧出厂头注**的文件（记忆文件） */
  stripped: string[];
}

/**
 * 这次启动用**兜底模板**写回的文件（**提示词 / 人格**）。
 *
 * ⚠️ **要记下来** —— 兜底模板很短（"够跑就行"），
 * 用户不知道就以为用的是仓库里的完整出厂版 → 行为变差却找不到原因
 * （见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md) 的「不要静默降级」）。
 */
const fallbackCreated: string[] = [];

/** 这次启动用兜底模板写回的文件（**提示词 / 人格**，不含 data/ 下的运行时文件） */
export function fallbackCreatedFiles(): string[] {
  return [...fallbackCreated];
}

/**
 * 摘掉记忆文件里的**旧出厂头注**。
 *
 * 📌 **为什么** —— 2026-11-01 起，记忆文件**不再自带「条目格式」头注**：
 * 那段样板长得像一条真记忆（会误导人），还白占字符预算
 * （`USER.md` 上限 1375 字符，头注就吃掉三分之一）。
 *
 * ⚠️ **只摘「文件开头正好是旧模板」的情况** ——
 *   用户自己写的头注一律保留（`renderMemoryFile` 的「文件头原样保留」约定）。
 * ⚠️ **条目不动** —— 旧模板后面的内容原样留下。
 */
function stripLegacyMemoryHeader(path: string, legacy: string): boolean {
  if (!existsSync(path)) return false;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  if (!raw.startsWith(legacy)) return false;

  const rest = raw.slice(legacy.length).trim();
  // ⚠️ **原子写** —— 记忆文件损坏 = 用户全部记忆丢失
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, rest, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败就算了 —— 真正的错误在下面报
    }
    // ⚠️ **失败不挡住启动** —— 头注只是样板文字，
    //   摘不掉也照常跑（顶多文件里还留着它）
    console.warn(
      `[Atlas] 移除旧出厂头注失败（不影响启动）：${path} —— ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  return true;
}

/** 确保出厂/运行时文件存在。返回新建了哪些。 */
export function ensureFiles(): EnsureResult {
  const created: string[] = [];

  // ── 提示词与人格：缺失则从兜底模板写回 ──
  const promptFiles: Array<[string, string]> = [
    [join(DIRS.prompts, 'system.md'), DEFAULT_SYSTEM_PROMPT],
    [join(DIRS.prompts, 'tool.md'), DEFAULT_TOOL_PROMPT],
    [join(DIRS.prompts, 'memory.md'), DEFAULT_MEMORY_PROMPT],
    [join(DIRS.prompts, 'summary.md'), DEFAULT_SUMMARY_PROMPT],
    [join(DIRS.prompts, 'skill.md'), DEFAULT_SKILL_PROMPT],
    [FILES.soul, DEFAULT_SOUL],
  ];
  for (const [path, content] of promptFiles) {
    if (writeIfMissing(path, content)) {
      created.push(path);
      fallbackCreated.push(path);
    }
  }

  // ── 运行时文件（data/ 下，不进 git）──
  const runtimeFiles: Array<[string, string]> = [
    [join(DIRS.memory, 'MEMORY.md'), MEMORY_FILE_TEMPLATE],
    [join(DIRS.memory, 'USER.md'), USER_FILE_TEMPLATE],
    [FILES.cron, CRON_FILE_TEMPLATE],
    [FILES.pricing, PRICING_FILE_TEMPLATE],
  ];
  for (const [path, content] of runtimeFiles) {
    if (writeIfMissing(path, content)) created.push(path);
  }

  // ── 记忆文件：摘掉旧出厂头注（2026-11-01 起不再生成）──
  const stripped: string[] = [];
  const legacyHeaders: Array<[string, string]> = [
    [join(DIRS.memory, 'MEMORY.md'), LEGACY_MEMORY_FILE_TEMPLATE],
    [join(DIRS.memory, 'USER.md'), LEGACY_USER_FILE_TEMPLATE],
  ];
  for (const [path, legacy] of legacyHeaders) {
    if (stripLegacyMemoryHeader(path, legacy)) stripped.push(path);
  }

  return { created, stripped };
}
