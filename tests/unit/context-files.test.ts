import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findProtectedWriteTargets,
  protectedContextFiles,
  protectedWriteTargets,
  restoreContextFiles,
  snapshotContextFiles,
} from '../../src/lib/security/context-files';

/**
 * 上下文文件保护的单元测试（见 [12-a A4](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * ⚠️ **为什么单测这一层**：
 * 「事前拦」认的是命令文本 —— 认错就是误伤（把正常的写文件也拦了），
 * 认漏就是漏防（还原那一道会兜住，但用户会先看到命令跑过了）。
 * 所以两种错都要测。
 */

/** 仓库根（**`context-files.ts` 只依赖 `paths.ts`，不读 `.env`**） */
const repoRoot = process.cwd();

describe('受保护的上下文文件', () => {
  it('📌 人格 / 项目指令 / 提示词都在保护名单里', () => {
    const files = protectedContextFiles();
    expect(files).toContain(join(repoRoot, 'AGENTS.md'));
    expect(files).toContain(join(repoRoot, 'SOUL.md'));
    expect(files).toContain(join(repoRoot, 'prompts', 'system.md'));
    expect(files).toContain(join(repoRoot, 'prompts', 'tool.md'));
  });

  it('📌 工作区里的普通文件不在名单里', () => {
    const files = protectedContextFiles();
    expect(files.some((file) => file.includes(`${join('data', 'workspace')}`))).toBe(false);
  });
});

describe('事前拦 · 认得出写入目标', () => {
  const cwd = join(repoRoot, 'data', 'workspace');

  it('📌 重定向到项目指令', () => {
    expect(protectedWriteTargets('echo x > ../../AGENTS.md', cwd)).toContain('AGENTS.md');
  });

  it('📌 绝对路径重定向', () => {
    expect(
      protectedWriteTargets(`echo x > ${join(repoRoot, 'AGENTS.md')}`, cwd),
    ).toContain('AGENTS.md');
  });

  it('📌 `>>` 追加也算写', () => {
    expect(protectedWriteTargets('echo x >> ../../AGENTS.md', cwd)).toContain('AGENTS.md');
  });

  it('📌 `tee`', () => {
    expect(
      protectedWriteTargets(`echo x | tee ${join(repoRoot, 'prompts', 'system.md')}`, cwd),
    ).toContain(join('prompts', 'system.md'));
  });

  it('📌 `cp` 的目标是最后一个参数', () => {
    expect(
      protectedWriteTargets(`cp a/b.txt ${join(repoRoot, 'SOUL.md')}`, cwd),
    ).toContain('SOUL.md');
  });

  it('📌 `rm` 的每个参数都算', () => {
    expect(
      protectedWriteTargets(`rm -rf /tmp/x ../../AGENTS.md`, cwd),
    ).toContain('AGENTS.md');
  });

  it('📌 `sed -i`', () => {
    expect(
      protectedWriteTargets(`sed -i 's/a/b/' ../../AGENTS.md`, cwd),
    ).toContain('AGENTS.md');
  });

  it('📌 `dd of=`', () => {
    expect(
      protectedWriteTargets(`dd if=/dev/zero of=../../AGENTS.md`, cwd),
    ).toContain('AGENTS.md');
  });

  it('📌 `mv`', () => {
    expect(protectedWriteTargets('mv ../../AGENTS.md ../../SOUL.md', cwd)).toContain('SOUL.md');
  });
});

describe('事前拦 · 别误伤', () => {
  const cwd = join(repoRoot, 'data', 'workspace');

  it('📌 工作区里写普通文件 → 不拦', () => {
    expect(protectedWriteTargets('echo x > notes.txt', cwd)).toEqual([]);
  });

  it('📌 读文件 → 不拦', () => {
    expect(protectedWriteTargets('cat ../../AGENTS.md', cwd)).toEqual([]);
  });

  it('📌 引号里的 `>` 不是重定向', () => {
    expect(protectedWriteTargets(`echo 'a > b'`, cwd)).toEqual([]);
  });

  it('📌 变量 / 通配符不猜（交给事后还原）', () => {
    expect(protectedWriteTargets('echo x > $TARGET', cwd)).toEqual([]);
    expect(protectedWriteTargets('echo x > *.md', cwd)).toEqual([]);
  });

  it('📌 工作区里一个叫 `system.md` 的文件照常能写', () => {
    expect(protectedWriteTargets('echo x > system.md', cwd)).toEqual([]);
  });
});

describe('事后还原', () => {
  it('📌 改过的文件还原回原样', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ctx-'));
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, '原来的内容\n', 'utf8');

    const snapshot = new Map([[file, '原来的内容\n']]);
    writeFileSync(file, '被改掉了\n', 'utf8');

    const restored = restoreContextFiles(snapshot);
    expect(restored.length).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('原来的内容\n');
  });

  it('📌 被删掉的文件还原回来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ctx-'));
    const file = join(dir, 'SOUL.md');
    writeFileSync(file, '人格\n', 'utf8');

    const snapshot = new Map([[file, '人格\n']]);
    rmSync(file);

    restoreContextFiles(snapshot);
    expect(readFileSync(file, 'utf8')).toBe('人格\n');
  });

  it('📌 本来不存在的文件被建出来 → 删掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ctx-'));
    const file = join(dir, 'NEW.md');

    const snapshot = new Map([[file, null]]);
    writeFileSync(file, '新建的\n', 'utf8');

    restoreContextFiles(snapshot);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('📌 没动过的文件不报', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ctx-'));
    const file = join(dir, 'SAME.md');
    writeFileSync(file, '没动\n', 'utf8');

    const snapshot = new Map([[file, '没动\n']]);
    expect(restoreContextFiles(snapshot)).toEqual([]);
  });
});

describe('快照', () => {
  it('📌 拍下来的是当前内容', () => {
    const snapshot = snapshotContextFiles();
    expect(snapshot.size).toBeGreaterThan(0);
    for (const [file, content] of snapshot) {
      expect(content === null || typeof content === 'string').toBe(true);
      expect(typeof file).toBe('string');
    }
  });

  it('📌 目标不是受保护文件 → 认不出来', () => {
    expect(findProtectedWriteTargets('echo x > a.txt', cwdOf())).toEqual([]);
  });
});

/** 随便一个工作目录 */
function cwdOf(): string {
  return join(repoRoot, 'data', 'workspace');
}
