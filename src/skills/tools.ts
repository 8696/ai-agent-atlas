import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { matchBlacklist } from '../lib/security/blacklist.js';
import {
  protectedWriteTargets,
  restoreContextFiles,
  snapshotContextFiles,
} from '../lib/security/context-files.js';
import { toolEnv } from '../lib/security/env.js';
import { isInside, realpathAllowMissing } from '../lib/security/sandbox.js';
import { parseArgs, schemas } from '../tools/args.js';
import { truncateOutput } from '../tools/output.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import { createSkill, isValidScriptPath, updateSkill } from './store.js';
import type { Skill } from './types.js';

/**
 * 技能工具 —— **技能怎么被用起来**
 * （见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * | 工具            | 用途                                   | 敏感档 |
 * | --------------- | -------------------------------------- | ------ |
 * | `skill_create`  | 新建一个技能（说明 + 可选脚本）       | normal |
 * | `skill_update`  | 改写已有技能的正文                     | normal |
 * | `skill_<名字>`  | 执行某个技能自带的脚本（**每个技能一个**） | **一律 high** |
 *
 * ⚠️ **全部走统一入口与权限闸** —— 技能脚本能执行任意代码，
 * 所以**一律 `high` 档**（要人确认），**不能绕过确认**（见 [12-c C3](./../docs/12-c-需求-工具技能与扩展.md)）。
 * ⚠️ **frontmatter 声明的 `sensitivity` 不能把脚本往下压** —— 脚本就是执行代码。
 */

/** `skill_create` 的入参 */
const skillCreateSchema = z.object({
  /** 技能名（kebab-case） */
  name: schemas.text(64),
  /** 触发条件描述 —— **给模型看**，它决定这个技能什么时候会被用上 */
  description: schemas.text(500),
  /** 正文 —— 使用说明（步骤、约束、输出格式） */
  body: schemas.text(8000),
  /** 可选脚本 */
  scripts: z
    .array(
      z.object({
        path: schemas.path,
        content: schemas.text(8000),
      }),
    )
    .max(10)
    .optional(),
});

/** `skill_update` 的入参 */
const skillUpdateSchema = z.object({
  /** 要改哪个技能 */
  name: schemas.text(64),
  /** 新正文 */
  body: schemas.text(8000),
});

/** 技能脚本工具的入参 */
const skillScriptSchema = z.object({
  /** 脚本的相对路径（如 `scripts/run.sh`） */
  script: schemas.path,
  /** 传给脚本的参数（**按 shell 风格切分，但不走 shell**） */
  args: schemas.text(2000).optional(),
});

/** 新建技能 */
export const skillCreateTool: ToolDefinition = {
  name: 'skill_create',
  description:
    '新建一个技能（可复用的做法）。技能会存成 data/skills/<name>/SKILL.md，' +
    'description 写清楚「什么场景该用它」，正文写使用步骤。' +
    '内容会先过一遍安全检查（有危险命令 / 提示词注入会被拒绝）。',
  schema: skillCreateSchema,
  sensitivity: 'normal',
  keywords: ['存成技能', '记成技能', '做成技能', '沉淀', '技能', 'skill', '固化'],
  riskNote: '会在 data/skills/ 下新建一个技能目录（内容会先过安全检查）。',
  source: 'skill',
  enabled: true,
  executor: 'subagent',
  async invoke(args): Promise<ToolResult> {
    const input = parseArgs(skillCreateSchema, args);
    const result = await createSkill({
      name: input.name,
      description: input.description,
      body: input.body,
      ...(input.scripts ? { scripts: input.scripts } : {}),
    });
    if (!result.ok) {
      return { ok: false, output: result.reason ?? '技能没写成功', error: 'SKILL_CREATE_FAILED' };
    }
    return {
      ok: true,
      output:
        `技能「${result.skill?.meta.name ?? input.name}」已创建 —— ` +
        '下一轮对话命中它时会把说明注入上下文。',
      data: { name: input.name },
    };
  },
};

/** 改写技能 */
export const skillUpdateTool: ToolDefinition = {
  name: 'skill_update',
  description:
    '改写一个已有技能的正文（说明部分）。用来把这次做对的做法补进技能里。' +
    '只改正文，元信息（名字、触发条件）保持不变。',
  schema: skillUpdateSchema,
  sensitivity: 'normal',
  keywords: ['改技能', '更新技能', '改进技能', '补充技能', '完善技能'],
  riskNote: '会覆盖 data/skills/<name>/SKILL.md 的正文（内容会先过安全检查）。',
  source: 'skill',
  enabled: true,
  executor: 'subagent',
  async invoke(args): Promise<ToolResult> {
    const input = parseArgs(skillUpdateSchema, args);
    const result = await updateSkill(input.name, input.body);
    if (!result.ok) {
      return { ok: false, output: result.reason ?? '技能没改成功', error: 'SKILL_UPDATE_FAILED' };
    }
    return {
      ok: true,
      output: `技能「${input.name}」的正文已更新。`,
      data: { name: input.name },
    };
  },
};

/**
 * 切分参数字符串 —— **按 shell 风格，但不走 shell**。
 *
 * 📌 **不走 shell** —— 参数直接进 argv，**不做变量展开 / 命令替换 / 管道**，
 * 这样脚本里收到的参数不会被二次解释。
 */
export function splitArgs(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current !== '') out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current !== '') out.push(current);
  return out;
}

/** 按扩展名选解释器 */
function interpreterFor(scriptPath: string): { command: string; prefix: string[] } | null {
  if (scriptPath.endsWith('.sh')) return { command: '/bin/sh', prefix: [] };
  if (scriptPath.endsWith('.py')) return { command: 'python3', prefix: [] };
  if (/\.(js|mjs|cjs)$/.test(scriptPath)) return { command: 'node', prefix: [] };
  if (scriptPath.endsWith('.rb')) return { command: 'ruby', prefix: [] };
  return null;
}

/** 脚本执行的结果 */
interface ScriptOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * 执行技能脚本。
 *
 * ⚠️ **路径必须落在技能目录内** —— resolve symlink 之后还要再判一次，
 * 否则技能目录里放一个指向 `/etc/passwd` 的软链就出去了
 * （见 [10 §10.4](./../docs/10-安全方案.md)）。
 */
export async function runSkillScript(
  skill: Skill,
  scriptPath: string,
  argsText: string | undefined,
): Promise<ToolResult> {
  if (!isValidScriptPath(scriptPath)) {
    return {
      ok: false,
      output: `脚本路径「${scriptPath}」不合法 —— 必须是技能目录内的相对路径`,
      error: 'INVALID_SCRIPT_PATH',
    };
  }

  const skillRoot = realpathAllowMissing(skill.dir);
  const target = resolve(skillRoot, scriptPath);
  const real = realpathAllowMissing(target);

  // ⚠️ **越界直接拒** —— 软链也算
  if (!isInside(skillRoot, real)) {
    return {
      ok: false,
      output: `脚本路径越出了技能目录（${real}）—— 只允许运行技能目录内的脚本`,
      error: 'PATH_OUTSIDE_SKILL',
    };
  }
  if (!existsSync(real) || !statSync(real).isFile()) {
    return {
      ok: false,
      output: `脚本不存在：${scriptPath}`,
      error: 'SCRIPT_NOT_FOUND',
    };
  }

  // ⚠️ **脚本内容也要过黑名单** —— 手工装进来的技能没经过写盘扫描
  let content: string;
  try {
    content = readFileSync(real, 'utf8');
  } catch {
    content = '';
  }
  const hit = matchBlacklist(content);
  if (hit) {
    const message = `脚本命中安全黑名单（${hit.name}：${hit.reason}），已拒绝执行`;
    return { ok: false, output: message, error: `COMMAND_BLOCKED: ${message}` };
  }

  // ⚠️ **上下文文件只读** —— 脚本同样不能改掉人格 / 项目指令 / 提示词
  //    （见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）
  const writeTargets = protectedWriteTargets(content, skillRoot);
  if (writeTargets.length > 0) {
    const message =
      `脚本试图改写上下文文件（${writeTargets.join('、')}）—— ` +
      '人格与项目指令只读，不允许通过脚本改写';
    return { ok: false, output: message, error: `CONTEXT_FILE_WRITE_BLOCKED: ${message}` };
  }

  // 📌 **跑之前拍快照** —— 跑完核对，被改了要还原
  const contextSnapshot = snapshotContextFiles();

  const args = splitArgs(argsText);
  const interpreter = interpreterFor(real);
  const isWindows = platform() === 'win32';

  let command: string;
  let argv: string[];
  if (interpreter) {
    command = interpreter.command;
    argv = [...interpreter.prefix, real, ...args];
  } else {
    // ⚠️ **没有扩展名 → 直接执行** —— 靠执行位
    command = real;
    argv = args;
  }
  if (isWindows) {
    command = 'cmd';
    argv = [
      '/c',
      ...(interpreter ? [interpreter.command, ...interpreter.prefix, real] : [real]),
      ...args,
    ];
  }

  const timeoutMs = config.TOOL_TIMEOUT_MS;
  const started = Date.now();
  const outcome = await new Promise<ScriptOutcome>((resolvePromise) => {
    const child = spawn(command, argv, {
      cwd: skillRoot,
      // ⚠️ **环境变量走白名单** —— 不继承 `process.env`，
      //    否则脚本里一句 `printenv LLM_API_KEY` 就能把密钥读出来
      env: toolEnv({ ATLAS_SKILL: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });

  const duration = Date.now() - started;

  // ⚠️ **事后核对** —— 事前拦不住的形态靠这一步兜住
  const restored = restoreContextFiles(contextSnapshot);
  const restoreNote =
    restored.length > 0
      ? `\n\n⚠️ 这个脚本改动了上下文文件（${restored.join('、')}），已还原 —— 那条路径不要再走。`
      : '';

  if (outcome.spawnError) {
    return {
      ok: false,
      output: `脚本启动失败：${outcome.spawnError}${restoreNote}`,
      error: `SPAWN_FAILED: ${outcome.spawnError}`,
    };
  }
  if (outcome.timedOut) {
    return {
      ok: false,
      output: `脚本超时（${timeoutMs}ms），已杀掉${restoreNote}`,
      error: `TIMEOUT: 脚本超时（${timeoutMs}ms）`,
    };
  }

  const combined = [outcome.stdout, outcome.stderr].filter(Boolean).join('\n');
  const clipped = truncateOutput(combined, config.TOOL_OUTPUT_MAX_CHARS, 'tail');
  const exitCode = outcome.code ?? 0;
  const header = `退出码：${exitCode}（耗时 ${duration}ms）\n`;

  if (exitCode !== 0) {
    return {
      ok: false,
      output: `${header}${clipped.text}${restoreNote}`,
      error: `EXIT_CODE_${exitCode}`,
      data: { exitCode, durationMs: duration, script: scriptPath },
      truncated: clipped.truncated,
      originalLength: clipped.originalLength,
    };
  }

  return {
    ok: true,
    output: `${header}${clipped.text || '(没有输出)'}${restoreNote}`,
    data: { exitCode, durationMs: duration, script: scriptPath },
    truncated: clipped.truncated,
    originalLength: clipped.originalLength,
  };
}

/**
 * 给一个技能生成「执行它的脚本」的工具。
 *
 * 📌 **每个技能一个工具** —— 这样敏感档可以按技能声明
 * （frontmatter 的 `sensitivity`，默认 `high`）。
 */
export function skillScriptTool(skill: Skill): ToolDefinition | null {
  if (skill.scripts.length === 0) return null;

  const scriptList = skill.scripts.map((item) => `\`${item}\``).join(' · ');
  const description = skill.meta.description
    ? `执行技能「${skill.meta.name}」自带的脚本（${skill.meta.description}）。可用脚本：${scriptList}`
    : `执行技能「${skill.meta.name}」自带的脚本。可用脚本：${scriptList}`;

  return {
    name: `skill_${skill.meta.name}`,
    description,
    schema: skillScriptSchema,
    // ⚠️ **脚本工具一律 `high`** —— frontmatter 声明的档位**不能往下压**。
    //    脚本 = 任意代码执行，跟它「打算做什么」无关；
    //    真要无人值守，走定时任务的 `autoApprove` 白名单（那条路是显式授权的）。
    sensitivity: 'high',
    riskNote: `会执行技能「${skill.meta.name}」里的脚本 —— 确认前先看清楚要跑的是哪个文件。`,
    source: 'skill',
    enabled: true,
    executor: 'subagent',
    async invoke(args): Promise<ToolResult> {
      const input = parseArgs(skillScriptSchema, args);
      return runSkillScript(skill, input.script, input.args);
    },
  };
}

/** 技能工具组（**新建 / 改写 + 每个带脚本的技能一个执行工具**） */
export function skillToolGroups(skills: Skill[]): Array<{
  source: 'skill';
  tools: ToolDefinition[];
}> {
  const tools: ToolDefinition[] = [skillCreateTool, skillUpdateTool];
  for (const skill of skills) {
    if (!skill.meta.enabled) continue;
    const tool = skillScriptTool(skill);
    if (tool) tools.push(tool);
  }
  return [{ source: 'skill', tools }];
}
