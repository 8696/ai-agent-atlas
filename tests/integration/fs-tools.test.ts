import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDatabase } from '../fixtures/db';

/**
 * 内置文件工具的集成测试 —— **真文件 · 真沙箱**（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **工作区在临时目录里** —— `ATLAS_HOME` 一换，路径基准就跟着换
 * （见 `tests/fixtures/db.ts` 的说明）。
 */

useTempDatabase();

const { paths } = await import('../../src/config');
const { fsTools } = await import('../../src/tools/builtin/fs');

/** 按名字取工具 */
function tool(name: string) {
  const found = fsTools.find((item) => item.name === name);
  if (!found) throw new Error(`没有这个工具：${name}`);
  return found;
}

/** 调工具（**统一入口**） */
function invoke(name: string, args: unknown) {
  return tool(name).invoke(args, {});
}

beforeAll(() => {
  mkdirSync(join(paths.workspaceRoot, 'sub'), { recursive: true });
  writeFileSync(join(paths.workspaceRoot, 'a.txt'), 'hello\nworld\n');
  writeFileSync(join(paths.workspaceRoot, 'sub', 'b.ts'), 'export const x = 1;\n');
  // 📌 **项目指令文件**（在项目根，不在工作区里）
  writeFileSync(paths.agents, '# 项目指令\n\n上下文文件标记XYZ\n', 'utf8');
});

describe('list_dir', () => {
  it('能列出工作区内的目录内容', async () => {
    const result = await invoke('list_dir', {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a.txt');
    expect(result.output).toContain('sub');
  });

  it('目录不存在 → 明确报错', async () => {
    const result = await invoke('list_dir', { path: 'nope' });
    expect(result.ok).toBe(false);
  });
});

describe('read_file', () => {
  it('读得到文件内容', async () => {
    const result = await invoke('read_file', { path: 'a.txt' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('⚠️ 读工作区外的文件 → 明确报错「路径超出工作区」', async () => {
    const result = await invoke('read_file', { path: '../../etc/passwd' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('超出工作区');
  });

  it('⚠️ 超大文件 → 截断并标注原始长度', async () => {
    const big = 'x'.repeat(20_000);
    writeFileSync(join(paths.workspaceRoot, 'big.txt'), big);
    const result = await invoke('read_file', { path: 'big.txt' });
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBeGreaterThan(4000);
    expect(result.output).toContain('已截断');
  });

  it('支持行范围', async () => {
    const result = await invoke('read_file', { path: 'a.txt', offset: 2, limit: 1 });
    expect(result.output).toContain('world');
    expect(result.output).not.toContain('hello');
  });

  it('📌 项目指令文件（`AGENTS.md`）能读 —— 它在项目根，不在工作区里', async () => {
    const result = await invoke('read_file', { path: 'AGENTS.md' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('上下文文件标记XYZ');
    // 📌 **不过全局截断** —— 模型要一次读完（截掉头只剩尾更糟）
    expect(result.truncate).toBe(false);
  });

  it('⚠️ 带目录的路径不算上下文文件 → 读不到项目根那份', async () => {
    const result = await invoke('read_file', { path: 'sub/AGENTS.md' });
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain('上下文文件标记XYZ');
  });

  it('⚠️ `../` 绕出去 → 越界', async () => {
    const result = await invoke('read_file', { path: '../AGENTS.md' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('超出工作区');
  });

  it('⚠️ `.env` 之类的东西读不到（只有上下文文件开了口子）', async () => {
    const result = await invoke('read_file', { path: '.env' });
    expect(result.ok).toBe(false);
  });
});

describe('write_file', () => {
  it('新文件能写进去', async () => {
    const result = await invoke('write_file', { path: 'new.txt', content: 'hi' });
    expect(result.ok).toBe(true);
  });

  it('⚠️ 覆盖已有文件且没传 overwrite → 拒绝', async () => {
    const result = await invoke('write_file', { path: 'a.txt', content: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('FILE_EXISTS');
  });

  it('传了 overwrite 才能覆盖', async () => {
    const result = await invoke('write_file', { path: 'a.txt', content: 'x', overwrite: true });
    expect(result.ok).toBe(true);
  });

  it('⚠️ 写到工作区外 → 被拦', async () => {
    const result = await invoke('write_file', { path: '../escape.txt', content: 'x' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('超出工作区');
  });
});

describe('delete_path', () => {
  it('工作区内的文件能删', async () => {
    writeFileSync(join(paths.workspaceRoot, 'gone.txt'), 'x');
    const result = await invoke('delete_path', { path: 'gone.txt' });
    expect(result.ok).toBe(true);
  });

  it('⚠️ 删工作区外的路径 → 被拦', async () => {
    const result = await invoke('delete_path', { path: '../escape.txt' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('超出工作区');
  });

  it('⚠️ 工作区根目录不能删', async () => {
    const result = await invoke('delete_path', { path: '.' });
    expect(result.ok).toBe(false);
  });
});

describe('search_files', () => {
  it('按通配找文件', async () => {
    const result = await invoke('search_files', { pattern: '*.ts' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('sub/b.ts');
  });

  it('按内容找文件', async () => {
    const result = await invoke('search_files', { content: 'export const x' });
    expect(result.output).toContain('sub/b.ts');
  });
});
