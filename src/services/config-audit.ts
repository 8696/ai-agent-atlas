import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { DIRS, PROJECT_ROOT } from '../config/paths.js';
import { logger } from '../logger.js';
import { writeAudit } from '../lib/audit.js';
import { AuditLog } from '../models/audit-log.model.js';

/**
 * 启动时的配置审计 —— **记一条 `CONFIG_LOADED` + 提示词变更**
 * （见 [12-a A5](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 📌 **配置 hash + git commit** —— 出了事能知道「当时跑的是哪份配置」。
 * 📌 **提示词改动也记** —— 提示词是文件，改了要能看出来。
 */

/** 一段内容的短 hash（**够分辨就行**） */
export function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 当前的 git commit（**拿不到就算了** —— 不装 git 的环境也能跑）。
 *
 * 📌 **不用子进程读 `.git`** —— worktree / packed refs 的情况太碎，
 * 直接问 git 更靠谱（失败就返回空串）。
 */
export function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 记配置审计（**启动时调一次**）。
 *
 * ⚠️ **失败只记日志** —— 审计挂了不该让服务起不来。
 */
export async function auditConfigOnStartup(): Promise<void> {
  try {
    const commit = currentCommit();
    const hash = shortHash(JSON.stringify(config));
    await writeAudit('CONFIG_LOADED', 'config', undefined, { hash, commit });
    await auditPromptChanges(commit);
  } catch (err) {
    logger.warn({ err }, '写配置审计失败');
  }
}

/**
 * 技能安装审计 —— **扫到新技能目录就记一条 `SKILL_INSTALLED`**
 * （见 [12-e E4](./docs/12-e-需求-观测安全与验收.md) 的审计清单）。
 *
 * ⚠️ **只记「第一次见到」的技能** —— 每次启动都写一遍会把审计表灌满，
 * 那就等于没有审计了。
 */
export async function auditSkillInstalls(skills: Array<{ meta: { name: string } }>): Promise<void> {
  for (const skill of skills) {
    try {
      const last = await AuditLog.findOne({
        where: { action: 'SKILL_INSTALLED', target_id: skill.meta.name },
        order: [['created_at', 'DESC']],
      });
      if (last) continue;
      await writeAudit('SKILL_INSTALLED', 'skill', skill.meta.name, { name: skill.meta.name });
    } catch (err) {
      logger.warn({ err, skill: skill.meta.name }, '写技能安装审计失败');
    }
  }
}

/** 提示词文件的清单（**`prompts/*.md` + `SOUL.md`**） */
function promptFiles(): string[] {
  const files: string[] = [];
  try {
    for (const name of readdirSync(DIRS.prompts)) {
      if (name.endsWith('.md')) files.push(join(DIRS.prompts, name));
    }
  } catch {
    // 目录不存在就跳过
  }
  files.push(join(PROJECT_ROOT, 'SOUL.md'));
  return files;
}

/**
 * 提示词变更审计 —— **内容变了就记一条 `PROMPT_UPDATED`**。
 *
 * 📌 **跟上一条比** —— 启动时读 `audit_logs` 里这个文件最近一次的 hash。
 */
async function auditPromptChanges(commit: string): Promise<void> {
  for (const path of promptFiles()) {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const hash = shortHash(content);

    const last = await AuditLog.findOne({
      where: { action: 'PROMPT_UPDATED', target_id: path },
      order: [['created_at', 'DESC']],
    });
    let previous = '';
    if (last?.details) {
      try {
        previous = (JSON.parse(last.details) as { hash?: string }).hash ?? '';
      } catch {
        previous = '';
      }
    }
    if (previous === hash) continue;

    await writeAudit('PROMPT_UPDATED', 'prompt', path, { hash, commit });
  }
}
