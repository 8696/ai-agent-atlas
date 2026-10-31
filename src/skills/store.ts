import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { DIRS } from '../config/paths.js';
import { logger } from '../logger.js';
import { writeAudit } from '../lib/audit.js';
import { ensureFtsTables, reindexSkills } from '../lib/fts.js';
import { matchBlacklist } from '../lib/security/blacklist.js';
import { scanInjection } from '../lib/security/injection.js';
import { looksLikeSecret } from '../lib/security/mask.js';
import { parseFrontmatter, renderFrontmatter } from './frontmatter.js';
import {
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  type Skill,
  type SkillMeta,
} from './types.js';

/**
 * 技能的读写 —— **技能包是目录**（见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ```
 * data/skills/pdf-report/
 * ├── SKILL.md          # 必需：说明（frontmatter + 正文）
 * ├── scripts/          # 可选：脚本
 * └── references/       # 可选：参考资料
 * ```
 *
 * 📌 **安装 = 手动拷目录 · 卸载 = 删目录** —— 没有上传界面。
 * 📌 **发现 = 启动时扫描** —— 改完重启才生效。
 *
 * ⚠️ **技能是「不可信代码」** —— 装进来的脚本能执行任意代码，
 * 所以写盘前要过危险内容检查，脚本默认 `high` 敏感档。
 */

/** 技能相关的问题（**启动时直接抛 —— 装错了就别起来**） */
export class SkillError extends Error {
  readonly code: string;

  constructor(message: string, code = 'SKILL_ERROR') {
    super(message);
    this.name = 'SkillError';
    this.code = code;
  }
}

/** 技能目录的绝对路径 */
export function skillDir(name: string): string {
  return join(DIRS.skills, name);
}

/** `SKILL.md` 的绝对路径 */
export function skillFilePath(name: string): string {
  return join(skillDir(name), 'SKILL.md');
}

/** 技能名合法吗（kebab-case） */
export function isValidSkillName(name: string): boolean {
  return (
    name.length > 0 && name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name)
  );
}

/**
 * 列一个子目录下的文件。
 *
 * 📌 **相对技能目录**（`scripts/run.sh`）—— 与 `skill_script` 工具的
 * `script` 入参口径一致，模型照着描述就能填对。
 */
function listFiles(root: string, sub: string): string[] {
  const base = join(root, sub);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  try {
    walk(base);
  } catch {
    return [];
  }
  return out.sort();
}

/** frontmatter 的字段 → 元信息 */
function toMeta(name: string, fields: Record<string, string>): SkillMeta {
  const sensitivityRaw = (fields['sensitivity'] ?? 'high').trim().toLowerCase();
  const sensitivity =
    sensitivityRaw === 'low' || sensitivityRaw === 'normal' ? sensitivityRaw : 'high';
  const enabledRaw = (fields['enabled'] ?? 'true').trim().toLowerCase();
  const version = (fields['version'] ?? '').trim();
  const autoUpdatedAt = (fields['autoUpdatedAt'] ?? '').trim();

  return {
    name,
    description: (fields['description'] ?? '').trim(),
    ...(version ? { version } : {}),
    enabled: enabledRaw !== 'false',
    sensitivity,
    autoCreated: (fields['autoCreated'] ?? '').trim().toLowerCase() === 'true',
    ...(autoUpdatedAt ? { autoUpdatedAt } : {}),
  };
}

/**
 * 读一个技能目录。
 *
 * 📌 **技能的身份 = frontmatter 的 `name`（没写就用目录名）** ——
 * 这样两个目录声明同一个名字时能被查出来（见 `discoverSkills`）。
 */
export function readSkill(name: string, root: string = DIRS.skills): Skill {
  const dir = join(root, name);
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) {
    throw new SkillError(`技能「${name}」缺少 SKILL.md`, 'SKILL_MISSING_MANIFEST');
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new SkillError(
      `技能「${name}」的 SKILL.md 读不出来：${err instanceof Error ? err.message : String(err)}`,
      'SKILL_UNREADABLE',
    );
  }

  const { fields, body } = parseFrontmatter(raw);
  const declared = (fields['name'] ?? '').trim();

  return {
    meta: toMeta(declared || name, fields),
    body: body.trim(),
    dir,
    scripts: listFiles(dir, 'scripts'),
    references: listFiles(dir, 'references'),
  };
}

/**
 * 扫描 `data/skills/` —— **启动时调一次**。
 *
 * ⚠️ **重名直接抛错** —— 两个技能同名会让「该用哪个」变成猜谜，
 * 与其猜不如启动失败并报告（见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md) 验收项）。
 */
export function discoverSkills(root: string = DIRS.skills): Skill[] {
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const skills: Skill[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    // ⚠️ **没有 SKILL.md 的目录不是技能包** —— 跳过（`scripts/` 之类的杂物目录）
    if (!existsSync(join(root, dirName, 'SKILL.md'))) continue;
    if (!isValidSkillName(dirName)) {
      throw new SkillError(
        `技能目录名「${dirName}」不合法 —— 要用 kebab-case（小写字母、数字、中划线）`,
        'SKILL_INVALID_NAME',
      );
    }

    const skill = readSkill(dirName, root);
    const identity = skill.meta.name;

    // ⚠️ **技能名必须与目录名一致** —— 否则同一个名字会被两个目录占
    if (identity !== dirName) {
      throw new SkillError(
        `技能名冲突：目录「${dirName}」里的 SKILL.md 声明自己是「${identity}」—— ` +
          '技能名必须唯一且与目录名一致',
        'SKILL_NAME_CONFLICT',
      );
    }

    const previous = seen.get(identity);
    if (previous) {
      throw new SkillError(
        `技能名冲突：「${identity}」被「${previous}」与「${dirName}」同时声明`,
        'SKILL_NAME_CONFLICT',
      );
    }
    seen.set(identity, dirName);
    skills.push(skill);
  }

  return skills.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
}

/** 进程内缓存的技能表 */
let cache: Skill[] | undefined;

/** 重新扫描技能目录（**启动时 & 写盘后**） */
export function reloadSkills(): Skill[] {
  cache = discoverSkills();
  return cache;
}

/** 已发现的技能（**没扫过就现扫**） */
export function getSkills(): Skill[] {
  if (!cache) cache = discoverSkills();
  return cache;
}

/** 按名字取一个技能 */
export function getSkill(name: string): Skill | undefined {
  return getSkills().find((skill) => skill.meta.name === name);
}

/** 危险内容检查 —— **写盘前过一遍** */
export interface SkillScanResult {
  /** 能写吗 */
  ok: boolean;
  /** 命中的原因（**能写时为空**） */
  reasons: string[];
}

/**
 * 扫一段要写进技能包的内容。
 *
 * ⚠️ **模型写的技能也是不可信内容** —— 不能直接落盘：
 * 1. **提示词注入** —— 「忽略之前的指令」这类
 * 2. **危险命令** —— `rm -rf` / `curl | sh` 这类（复用 shell 的黑名单）
 * 3. **凭据外泄** —— 内容里出现 API Key
 *
 * 📌 **命中就拒绝写入**（不是告警）—— 技能是**持久化**的注入通道。
 */
export function scanSkillContent(text: string): SkillScanResult {
  const reasons: string[] = [];

  const injection = scanInjection(text);
  if (injection.detected) {
    reasons.push(`疑似提示词注入（${injection.matches.join('、')}）`);
  }

  const hit = matchBlacklist(text);
  if (hit) {
    reasons.push(`含危险命令（${hit.name}：${hit.reason}）`);
  }

  if (looksLikeSecret(text)) {
    reasons.push('内容里像是有 API Key / 令牌');
  }

  return { ok: reasons.length === 0, reasons };
}

/** 原子写 —— **写临时文件再 `rename`** */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败就算了 —— 真正的错误在下面抛
    }
    throw err;
  }
}

/** 写盘的结果 */
export interface SkillWriteResult {
  ok: boolean;
  /** 失败原因（**给用户看的一句话**） */
  reason?: string;
  /** 写完之后的技能 */
  skill?: Skill;
}

/** 要写进技能的脚本 */
export interface SkillScriptInput {
  /** 相对技能目录的路径（如 `scripts/run.sh`） */
  path: string;
  /** 脚本内容 */
  content: string;
}

/** 脚本路径合法吗（**不许越出技能目录**） */
export function isValidScriptPath(path: string): boolean {
  if (path.trim() === '') return false;
  if (path.includes('\0')) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..')) return false;
  return true;
}

/**
 * 新建一个技能。
 *
 * 📌 **每轮最多自动建一个**（节制由调用方保证，见 `autocreate.ts`）。
 * ⚠️ **同名不覆盖** —— 已有同名技能要走 `updateSkill`。
 */
export async function createSkill(input: {
  name: string;
  description: string;
  body: string;
  scripts?: SkillScriptInput[];
  version?: string | undefined;
  sensitivity?: SkillMeta['sensitivity'] | undefined;
}): Promise<SkillWriteResult> {
  const name = input.name.trim();

  if (!isValidSkillName(name)) {
    return {
      ok: false,
      reason: `技能名「${name}」不合法 —— 用 kebab-case（小写字母、数字、中划线，≤ ${SKILL_NAME_MAX_LENGTH} 字符）`,
    };
  }

  const dir = skillDir(name);
  // ⚠️ **同名不覆盖** —— 目录里有、或者已经有一个同名技能，都要走 `skill_update`
  if (existsSync(join(dir, 'SKILL.md')) || getSkill(name)) {
    return { ok: false, reason: `技能「${name}」已经存在 —— 要改内容请用 skill_update` };
  }

  // ⚠️ **写盘前扫描** —— 正文与脚本都扫
  const scripts = input.scripts ?? [];
  const scan = scanSkillContent(
    [input.description, input.body, ...scripts.map((item) => `${item.path}\n${item.content}`)].join(
      '\n',
    ),
  );
  if (!scan.ok) {
    return { ok: false, reason: `技能内容没通过安全检查：${scan.reasons.join('；')}` };
  }

  for (const script of scripts) {
    if (!isValidScriptPath(script.path)) {
      return { ok: false, reason: `脚本路径「${script.path}」不合法 —— 必须是技能目录内的相对路径` };
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
    if (scripts.length > 0) mkdirSync(join(dir, 'scripts'), { recursive: true });
    const content = renderFrontmatter(
      {
        name,
        description: input.description.trim(),
        ...(input.version ? { version: input.version.trim() } : {}),
        enabled: true,
        sensitivity: input.sensitivity ?? 'high',
        // 📌 **Agent 建出来的技能一律标 `autoCreated`** ——
        //    人工拷目录装进来的技能没有这一行（可信度更高）
        autoCreated: true,
      },
      input.body,
    );
    atomicWrite(join(dir, 'SKILL.md'), content);

    for (const script of scripts) {
      const target = join(dir, script.path);
      mkdirSync(dirname(target), { recursive: true });
      atomicWrite(target, script.content);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `写入失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  reloadSkills();
  // 📌 **索引同步重建** —— 不等它完成的话，这一轮就搜不到新技能
  await syncSkillIndex();

  void writeAudit('SKILL_AUTOCREATED', 'skill', name, {
    name,
    description: input.description,
    scripts: scripts.map((item) => item.path),
  });

  const skill = getSkill(name);
  return skill ? { ok: true, skill } : { ok: false, reason: '技能已写入但没能重新读到' };
}

/**
 * 改写一个技能的正文。
 *
 * 📌 **保留 frontmatter** —— 人工编辑过的技能（`autoCreated` 被去掉）不能被改回来。
 *
 * @param options.touched 自动更新时为 true —— **记下 `autoUpdatedAt`**（24 小时冷却用）
 */
export async function updateSkill(
  name: string,
  body: string,
  options: { touched?: boolean } = {},
): Promise<SkillWriteResult> {
  const skill = getSkill(name);
  if (!skill) {
    return { ok: false, reason: `没有这个技能：${name}` };
  }

  const scan = scanSkillContent(body);
  if (!scan.ok) {
    return { ok: false, reason: `技能内容没通过安全检查：${scan.reasons.join('；')}` };
  }

  // 📌 **自动更新要记下时间** —— 24 小时冷却用
  const autoUpdatedAt = options.touched
    ? new Date().toISOString()
    : (skill.meta.autoUpdatedAt ?? '');

  // ⚠️ **保留原有的元信息** —— 只换正文
  const content = renderFrontmatter(
    {
      name: skill.meta.name,
      description: skill.meta.description,
      ...(skill.meta.version ? { version: skill.meta.version } : {}),
      enabled: skill.meta.enabled,
      sensitivity: skill.meta.sensitivity,
      ...(skill.meta.autoCreated ? { autoCreated: true } : {}),
      ...(autoUpdatedAt ? { autoUpdatedAt } : {}),
    },
    body,
  );

  try {
    atomicWrite(join(skill.dir, 'SKILL.md'), content);
  } catch (err) {
    return {
      ok: false,
      reason: `写入失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  reloadSkills();
  // 📌 **索引同步重建** —— 不等它完成的话，这一轮就搜不到新技能
  await syncSkillIndex();

  void writeAudit('SKILL_AUTOUPDATED', 'skill', name, {
    name,
    autoCreated: skill.meta.autoCreated,
    ...(options.touched ? { auto: true } : {}),
  });

  const updated = getSkill(name);
  return updated ? { ok: true, skill: updated } : { ok: false, reason: '技能已写入但没能重新读到' };
}

/** 重建技能的检索索引（**技能在文件里，索引在库里**） */
export async function syncSkillIndex(): Promise<void> {
  try {
    await ensureFtsTables();
    await reindexSkills(
      getSkills().map((skill) => ({
        name: skill.meta.name,
        description: skill.meta.description,
        body: skill.body.slice(0, 2000),
      })),
    );
  } catch (err) {
    logger.warn({ err }, '重建技能索引失败 —— 只影响检索，不影响技能本身');
  }
}
