import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDatabase } from '../fixtures/db';

/**
 * `shell` 工具的集成测试 —— **真子进程**（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 覆盖三件以前会出事的事：
 * - ⚠️ **`cwd` 不过路径沙箱** —— 模型传个 `/etc` 或 `../..` 就能把工作目录搬出去
 * - ⚠️ **子进程继承完整 `process.env`** —— 一句 `printenv LLM_API_KEY` 就把密钥读出来
 * - ⚠️ **命令黑名单只在工具内部判** —— 用户先看到确认卡片，批准了才被告知不让跑
 */

useTempDatabase();

const { paths } = await import('../../src/config');
const { shellTool } = await import('../../src/tools/builtin/shell');
const { decideTool } = await import('../../src/lib/security/policy');

/** 调工具 */
function invoke(args: unknown) {
  return shellTool.invoke(args, {});
}

beforeAll(() => {
  mkdirSync(join(paths.workspaceRoot, 'sub'), { recursive: true });
  writeFileSync(join(paths.workspaceRoot, 'sub', 'b.txt'), 'inside\n');
  // 📌 **项目指令文件也得有** —— 它是受保护的上下文文件之一
  writeFileSync(join(paths.projectRoot, 'AGENTS.md'), '# 项目指令\n\n别改我。\n', 'utf8');
});

describe('shell · 工作目录', () => {
  it('默认在工作区根里跑', async () => {
    const result = await invoke({ command: 'pwd' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(paths.workspaceRoot);
  });

  it('相对路径的 cwd → 解析到工作区内', async () => {
    const result = await invoke({ command: 'pwd', cwd: 'sub' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(join(paths.workspaceRoot, 'sub'));
  });

  it('⚠️ 绝对路径的 cwd 指向工作区外 → 拒绝', async () => {
    const result = await invoke({ command: 'pwd', cwd: '/etc' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('CWD_OUTSIDE_WORKSPACE');
    expect(result.output).toContain('超出工作区');
  });

  it('⚠️ `../..` 往上爬 → 拒绝', async () => {
    const result = await invoke({ command: 'pwd', cwd: '../..' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('CWD_OUTSIDE_WORKSPACE');
  });
});

describe('shell · 子进程环境', () => {
  it('⚠️ 子进程里拿不到 API Key', async () => {
    const result = await invoke({ command: 'echo "[${LLM_API_KEY:-EMPTY}]"' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('[EMPTY]');
  });

  it('⚠️ 子进程里拿不到备用模型的 Key', async () => {
    const result = await invoke({ command: 'echo "[${LLM_FALLBACK_API_KEY:-EMPTY}]"' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('[EMPTY]');
  });

  it('该有的还在（PATH 之类）', async () => {
    const result = await invoke({ command: 'echo "[${PATH:-EMPTY}]"' });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain('[EMPTY]');
  });
});

describe('shell · 黑名单在策略层', () => {
  it('⚠️ 命中黑名单 → 直接 blocked（不弹确认卡片）', () => {
    const decision = decideTool(
      { name: 'shell', sensitivity: 'high', source: 'builtin' },
      { args: { command: 'rm -rf /' } },
    );
    expect(decision.decision).toBe('blocked');
  });

  it('普通命令 → 照常走确认闸', () => {
    const decision = decideTool(
      { name: 'shell', sensitivity: 'high', source: 'builtin' },
      { args: { command: 'ls -la' } },
    );
    expect(decision.decision).toBe('await');
  });

  it('工具内部还有一道兜底（**别的入口也走这条**）', async () => {
    const result = await invoke({ command: 'rm -rf /' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('COMMAND_BLOCKED');
  });
});

/**
 * ⚠️ **上下文文件只读** —— 人格（`SOUL*.md`）/ 项目指令（`AGENTS.md`）/
 * 提示词（`prompts/*.md`）**不能被命令改掉**
 * （见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **文件工具的路径沙箱管不到命令内容** ——
 * `echo x > ../../AGENTS.md` 直接落在项目根，
 * 那等于给模型开了一个「永久改写自己提示词」的口子。
 */
describe('shell · 上下文文件只读', () => {
  const agentsPath = join(paths.projectRoot, 'AGENTS.md');

  it('⚠️ 直接重定向改写 `AGENTS.md` → 拒绝', async () => {
    const result = await invoke({ command: `echo '恶意指令' > ${agentsPath}` });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CONTEXT_FILE_WRITE_BLOCKED');
  });

  it('⚠️ 相对路径爬回项目根改写 → 拒绝', async () => {
    const result = await invoke({ command: "echo '恶意指令' > ../../AGENTS.md" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CONTEXT_FILE_WRITE_BLOCKED');
  });

  it('⚠️ `tee` 改写 `prompts/system.md` → 拒绝', async () => {
    const result = await invoke({
      command: `echo '恶意指令' | tee ${join(paths.prompts, 'system.md')}`,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CONTEXT_FILE_WRITE_BLOCKED');
  });

  it('⚠️ `cp` 覆盖 `SOUL.md` → 拒绝', async () => {
    const result = await invoke({
      command: `cp ${join(paths.workspaceRoot, 'sub', 'b.txt')} ${join(paths.projectRoot, 'SOUL.md')}`,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CONTEXT_FILE_WRITE_BLOCKED');
  });

  it('⚠️ 事前拦不住的形态 → 跑完核对并还原', async () => {
    // 📌 **python 改文件** —— 正则拦不住，只能靠事后还原
    const result = await invoke({
      command: `python3 -c "open('${agentsPath}','w').write('恶意指令')"`,
    });
    expect(result.output).toContain('已还原');
    expect(readFileSync(agentsPath, 'utf8')).not.toContain('恶意指令');
  });

  it('⚠️ 删掉 `AGENTS.md` → 事前就拦下（文件还在）', async () => {
    const before = readFileSync(agentsPath, 'utf8');
    const result = await invoke({ command: `rm ${agentsPath}` });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CONTEXT_FILE_WRITE_BLOCKED');
    expect(readFileSync(agentsPath, 'utf8')).toBe(before);
  });

  it('⚠️ `rm` 后面跟多个参数时也能认出目标', async () => {
    const result = await invoke({ command: `rm -rf /tmp/xx ${agentsPath}` });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CONTEXT_FILE_WRITE_BLOCKED');
  });

  it('工作区里的普通文件照常能写（**别误伤**）', async () => {
    const target = join(paths.workspaceRoot, 'sub', 'normal.txt');
    const result = await invoke({ command: `echo 'ok' > ${target}` });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf8').trim()).toBe('ok');
  });

  it('读上下文文件不拦（**只拦写**）', async () => {
    const result = await invoke({ command: `head -1 ${agentsPath}` });
    expect(result.ok).toBe(true);
  });
});
