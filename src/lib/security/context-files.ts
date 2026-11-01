import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DIRS, FILES, PROJECT_ROOT } from '../../config/paths.js';
import { realpathAllowMissing } from './sandbox.js';

/**
 * 上下文文件保护 —— **人格与项目指令只读**
 * （见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **为什么需要这一层**：
 * 文件工具的路径沙箱只认工作区（`data/workspace/`），
 * 项目根的 `SOUL.md` / `AGENTS.md` 确实写不了 ——
 * 但 **`shell` 工具的命令内容不受路径沙箱管**
 * （`echo x > ../../AGENTS.md` 直接落在项目根），技能脚本同理。
 * 那等于给模型开了一个「永久改写自己提示词」的口子 ——
 * 一次 shell 就能把人格与项目指令换掉，后面每轮都按新的来。
 *
 * 📌 **两道防线**：
 * 1. **事前拦**（`findProtectedWriteTargets`）—— 明显的写入命令**在跑之前就拒**
 * 2. **事后还原**（`snapshotContextFiles` / `restoreContextFiles`）——
 *    正则拦不住的形态（`python -c "open(...)"`）也能兜住
 *
 * ⚠️ **只保护「上下文」文件** —— 工作区里的普通文件照常能写。
 */

/** 受保护的上下文文件（**绝对路径**） */
export function protectedContextFiles(): string[] {
  const files = new Set<string>([FILES.agents]);

  // 人格文件（`SOUL*.md`，项目根）
  try {
    for (const name of readdirSync(PROJECT_ROOT)) {
      if (/^SOUL[A-Za-z0-9_-]*\.md$/.test(name)) files.add(join(PROJECT_ROOT, name));
    }
  } catch {
    // 读不到项目根就只保住已知的那几个
  }

  // 提示词文件（`prompts/*.md` —— 应用资产，跟人格同级）
  try {
    for (const name of readdirSync(DIRS.prompts)) {
      if (name.endsWith('.md')) files.add(join(DIRS.prompts, name));
    }
  } catch {
    // 同上
  }

  return [...files];
}

/** 这个绝对路径是不是只读的上下文文件（人格 / 项目指令 / 提示词） */
export function isProtectedContextFile(target: string): boolean {
  const real = realpathAllowMissing(target);
  return protectedContextFiles().some((file) => realpathAllowMissing(file) === real);
}

/** 快照 —— 文件内容（**`null` = 本来就不存在**） */
export type ContextSnapshot = Map<string, string | null>;

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 拍快照（**跑命令之前**） */
export function snapshotContextFiles(): ContextSnapshot {
  const snapshot: ContextSnapshot = new Map();
  for (const file of protectedContextFiles()) {
    snapshot.set(file, readIfExists(file));
  }
  return snapshot;
}

/**
 * 核对 + 还原 —— **把被改动的上下文文件还原回原样**。
 *
 * @returns 被还原的文件（相对项目根；还原失败的也列出来 —— 静默失败等于没保护）
 */
export function restoreContextFiles(snapshot: ContextSnapshot): string[] {
  const restored: string[] = [];
  for (const [file, original] of snapshot) {
    if (readIfExists(file) === original) continue;
    const name = file.replace(`${PROJECT_ROOT}/`, '');
    try {
      if (original === null) {
        rmSync(file, { force: true });
      } else {
        writeFileSync(file, original, 'utf8');
      }
      restored.push(name);
    } catch {
      restored.push(`${name}（还原失败 —— 请手动检查这个文件）`);
    }
  }
  return restored;
}

/**
 * 把命令切成词（**引号内的算一个词**）。
 *
 * ⚠️ **不是完整的 shell 解析器** —— 只够认出「写到哪里」。
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** 命令的「断点」—— 到了这里就不是当前这条命令的参数了 */
const BREAK_TOKENS = new Set([';', '|', '||', '&&', '&', '\n', '`']);

/** 从 `start` 开始取参数，直到撞上断点 */
function argsUntilBreak(tokens: string[], start: number): string[] {
  const args: string[] = [];
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (BREAK_TOKENS.has(token)) break;
    args.push(token);
  }
  return args;
}

/** 把命令里的候选路径解析成绝对路径（**相对 shell 的工作目录**） */
function resolveCandidate(token: string, cwd: string): string | null {
  if (token === '' || token === '-') return null;
  // 📌 **变量 / 通配符不猜** —— `$VAR`、`*`、`~` 都交给事后还原
  if (/[${}*?~]/.test(token)) return null;
  return isAbsolute(token) ? resolve(token) : resolve(cwd, token);
}

/**
 * 这条命令看起来要写哪些**受保护的上下文文件**。
 *
 * ⚠️ **这是「事前拦」那一道，不是安全边界** ——
 * 命令可以绕（base64、`python -c`、变量展开…），
 * 所以另一道防线 `restoreContextFiles()` 必须在跑完之后再核对一次。
 *
 * 📌 **只认常见写法** —— 宁可漏（交给事后还原），不要误伤
 * （把工作区里正常写文件也拦了比不拦更糟）。
 */
export function findProtectedWriteTargets(command: string, cwd: string): string[] {
  const protectedFiles = new Set(protectedContextFiles());
  if (protectedFiles.size === 0) return [];

  const tokens = tokenize(command);
  const hits = new Set<string>();
  const check = (token: string): void => {
    const absolute = resolveCandidate(token, cwd);
    if (absolute && protectedFiles.has(absolute)) hits.add(absolute);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';

    // ── 重定向：`>` `>>` `2>` `&>` ──
    if (/^(?:\d*|&)?>>?$/.test(token)) {
      const target = tokens[i + 1];
      if (target) check(target);
      continue;
    }
    // 📌 **`>file` 连在一起写** —— 拆出目标
    const redirect = /^(?:\d*|&)?>>?(.+)$/.exec(token);
    if (redirect?.[1]) {
      check(redirect[1]);
      continue;
    }

    // ── `tee` ──
    if (token === 'tee') {
      for (const arg of argsUntilBreak(tokens, i + 1)) {
        if (!arg.startsWith('-')) check(arg);
      }
      continue;
    }

    // ── `cp` / `mv` / `install` —— 目标是最后一个参数 ──
    if (token === 'cp' || token === 'mv' || token === 'install') {
      const args = argsUntilBreak(tokens, i + 1);
      const last = args[args.length - 1];
      if (last) check(last);
      continue;
    }

    // ── `rm` —— 每个参数都是目标 ──
    if (token === 'rm') {
      for (const arg of argsUntilBreak(tokens, i + 1)) {
        if (!arg.startsWith('-')) check(arg);
      }
      continue;
    }

    // ── `sed -i` / `perl -i` —— 最后一个参数是文件 ──
    if (
      (token === 'sed' || token === 'perl') &&
      argsUntilBreak(tokens, i + 1).some((arg) => /^-i/.test(arg))
    ) {
      const args = argsUntilBreak(tokens, i + 1).filter((arg) => !arg.startsWith('-'));
      const last = args[args.length - 1];
      if (last) check(last);
      continue;
    }

    // ── `dd of=file` ──
    if (token === 'dd') {
      for (const arg of argsUntilBreak(tokens, i + 1)) {
        const of = /^of=(.+)$/.exec(arg);
        if (of?.[1]) check(of[1]);
      }
      continue;
    }

    // ── `truncate file` ──
    if (token === 'truncate') {
      const args = argsUntilBreak(tokens, i + 1).filter((arg) => !arg.startsWith('-'));
      const first = args[0];
      if (first) check(first);
      continue;
    }
  }
  return [...hits];
}

/**
 * 这条命令会不会改到受保护的上下文文件。
 *
 * @returns 命中的文件相对路径（**空数组 = 没命中**）
 */
export function protectedWriteTargets(command: string, cwd: string): string[] {
  return findProtectedWriteTargets(command, cwd).map((file) =>
    file.replace(`${PROJECT_ROOT}/`, ''),
  );
}
