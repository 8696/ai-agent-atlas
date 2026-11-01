import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FILES } from '../../config/paths.js';

/**
 * 路径沙箱 —— **所有文件工具的第一道门**（见 [10 §10.4](../../docs/10-安全方案.md)）。
 *
 * ```
 * 所有文件工具的路径：
 *   ① 规范化（resolve，⚠️ 含 symlink）
 *   ② 判是否在 workspace_root 内
 *   ③ 越界 → 明确报错
 * ```
 *
 * ⚠️ **必须 resolve symlink** —— 只做字符串前缀判断的话，
 * 工作区里放一个指向 `/etc/passwd` 的软链就出去了。
 *
 * ⚠️ **路径本身也要查**：`../`、绝对路径、null 字节、超长路径。
 */

/** 越界错误（**明确报错，不静默失败**） */
export class SandboxError extends Error {
  readonly code: string;

  constructor(message: string, code = 'PATH_OUTSIDE_WORKSPACE') {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** 路径长度上限（**超长路径直接拒** —— 正常路径用不了这么长） */
const MAX_PATH_LENGTH = 4096;

/**
 * 项目上下文文件 —— **只读**（见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **`AGENTS.md` / `SOUL.md` 在项目根，不在工作区里** ——
 *    但它们**只被截断着注入**系统提示词（省 token），
 *    模型要看后面的章节时得能自己读全文。
 *
 * 📌 **只认裸文件名** —— `AGENTS.md` 行，`sub/AGENTS.md` 不行，
 * 更不能拿 `../` 绕出去（那就把整个项目根开放了）。
 *
 * ⚠️ **只读** —— 写这两个文件照样越界（它们不在工作区里，
 * 写工具根本到不了）。
 */
const CONTEXT_FILES: Record<string, string> = {
  'agents.md': FILES.agents,
  'soul.md': FILES.soul,
};

/**
 * 这个路径是不是「项目上下文文件」（**是就返回它的绝对路径**）。
 *
 * @returns 绝对路径；不是上下文文件就返回 `undefined`
 */
export function resolveContextFile(inputPath: unknown): string | undefined {
  if (typeof inputPath !== 'string') return undefined;
  const name = inputPath.trim().toLowerCase();
  // ⚠️ **只认裸文件名** —— 带目录的一律不认
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return undefined;
  }
  return CONTEXT_FILES[name];
}

/**
 * 把路径解析成「真实路径」（**软链已解开**）。
 *
 * ⚠️ **目标不存在时**（写文件新建）→ 往上找第一个存在的祖先，
 * 解它的软链，再把剩下的路径接回去 —— 否则 `data/workspace` 本身是软链时会判错。
 */
export function realpathAllowMissing(target: string): string {
  let current = target;
  const tail: string[] = [];

  for (let i = 0; i < 64; i += 1) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return resolve(current, ...tail.reverse());
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
  return resolve(current, ...tail.reverse());
}

/**
 * 判断 `target` 是否在 `root` 之内。
 *
 * ⚠️ **用 `relative` 而不是字符串前缀** —— `/workspace-evil` 不该被
 * `/workspace` 的前缀判断放行。
 */
export function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 把模型给的路径解析成工作区内的绝对路径。
 *
 * @param inputPath 模型给的路径（相对路径按**工作区根**解析，不是 cwd）
 * @param workspaceRoot 工作区根（已 resolve 的绝对路径）
 * @param options.allowRoot 是否允许就落在工作区根本身（删工作区根要禁止）
 */
export function resolveInWorkspace(
  inputPath: string,
  workspaceRoot: string,
  options: { allowRoot?: boolean } = {},
): string {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new SandboxError('路径不能为空', 'INVALID_PATH');
  }
  if (inputPath.includes('\0')) {
    throw new SandboxError('路径里有空字节', 'INVALID_PATH');
  }
  if (inputPath.length > MAX_PATH_LENGTH) {
    throw new SandboxError('路径太长', 'INVALID_PATH');
  }

  const root = realpathAllowMissing(workspaceRoot);
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const real = realpathAllowMissing(absolute);

  if (!isInside(root, real)) {
    throw new SandboxError(
      `路径超出工作区（${real}）—— 只能访问 ${root} 内的文件`,
      'PATH_OUTSIDE_WORKSPACE',
    );
  }
  if (!options.allowRoot && real === root) {
    throw new SandboxError('不能操作工作区根目录本身', 'PATH_IS_WORKSPACE_ROOT');
  }
  return real;
}

/**
 * 解析路径，但**最后一段的软链不解开** —— **删除操作用这个**。
 *
 * ⚠️ **为什么** —— `resolveInWorkspace` 会把整条路径的软链都解开，
 *    于是「删一个软链」实际删掉的是**它指向的东西**（工作区里的真实文件）。
 *    文档承诺的是「**软链只删链接本身**，不删它指向的东西」
 *    （见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **只解开父目录** —— 父目录是软链的话照样解开（那是路径穿越的口子），
 *    但**最后一段留着不动**（那才是「要删的东西」本身）。
 */
export function resolveInWorkspaceKeepLink(inputPath: string, workspaceRoot: string): string {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new SandboxError('路径不能为空', 'INVALID_PATH');
  }
  if (inputPath.includes('\0')) {
    throw new SandboxError('路径里有空字节', 'INVALID_PATH');
  }

  const root = realpathAllowMissing(workspaceRoot);
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);

  // ── 拆成「父目录 + 文件名」 ──
  const parent = dirname(absolute);
  const name = basename(absolute);
  // 📌 **父目录照样解软链** —— 路径穿越的口子在那儿
  const realParent = realpathAllowMissing(parent);
  const kept = join(realParent, name);

  if (!isInside(root, kept)) {
    throw new SandboxError(
      `路径超出工作区（${kept}）—— 只能访问 ${root} 内的文件`,
      'PATH_OUTSIDE_WORKSPACE',
    );
  }
  return kept;
}

/**
 * 工作区根目录本身（**永远不许被删**）。
 *
 * ⚠️ **软链也要解开** —— 否则工作区里放一个指向根目录的软链就能把根删了。
 */
export function assertNotWorkspaceRoot(target: string, workspaceRoot: string): void {
  const root = realpathAllowMissing(workspaceRoot);
  if (realpathAllowMissing(target) === root) {
    throw new SandboxError('不能删除工作区根目录本身', 'PATH_IS_WORKSPACE_ROOT');
  }
}

/** 把绝对路径换回**工作区内的相对路径**（给模型看 —— 绝对路径泄露目录结构） */
export function toWorkspaceRelative(target: string, workspaceRoot: string): string {
  const root = realpathAllowMissing(workspaceRoot);
  // 📌 **只解父目录的软链** —— 最后一段要是软链，解了就变成「它指向的东西」
  //    （macOS 的临时目录本身就是软链（`/var` → `/private/var`）—— 父目录那层要解）
  const parent = realpathAllowMissing(dirname(target));
  const rel = relative(root, join(parent, basename(target)));
  if (rel === '' || rel.startsWith('..')) return target;
  return rel.split(sep).join('/');
}
