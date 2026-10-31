import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SandboxError,
  assertNotWorkspaceRoot,
  isInside,
  resolveInWorkspace,
  toWorkspaceRelative,
} from '../../src/lib/security/sandbox';

/**
 * 路径沙箱的单元测试 —— **纯本地，不碰配置**。
 *
 * 覆盖：越界拦截 · 软链逃逸 · 工作区根不可删 · 相对路径展示。
 */

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-sandbox-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'b.txt'), 'world');
  return root;
}

describe('路径沙箱', () => {
  it('工作区内的相对路径能解析', () => {
    const root = makeWorkspace();
    // ⚠️ **期望值用 realpath** —— 沙箱返回的是**解开软链**后的路径
    //    （macOS 的临时目录本身就是软链：`/var` → `/private/var`）
    expect(resolveInWorkspace('a.txt', root)).toBe(join(realpathSync(root), 'a.txt'));
    expect(resolveInWorkspace('sub/b.txt', root)).toBe(join(realpathSync(root), 'sub', 'b.txt'));
  });

  it('⚠️ `../` 越界被拦', () => {
    const root = makeWorkspace();
    expect(() => resolveInWorkspace('../../etc/passwd', root)).toThrow(SandboxError);
    expect(() => resolveInWorkspace('../../etc/passwd', root)).toThrow(/超出工作区/);
  });

  it('⚠️ 绝对路径越界被拦', () => {
    const root = makeWorkspace();
    expect(() => resolveInWorkspace('/etc/passwd', root)).toThrow(/超出工作区/);
  });

  it('⚠️ 工作区里的软链指向外部 → 照样被拦', () => {
    const root = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'atlas-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));

    expect(() => resolveInWorkspace('link.txt', root)).toThrow(/超出工作区/);
  });

  it('⚠️ 不存在的文件也能判越界（写文件新建时）', () => {
    const root = makeWorkspace();
    expect(() => resolveInWorkspace('new/deep/file.txt', root)).not.toThrow();
    expect(() => resolveInWorkspace('../outside.txt', root)).toThrow(/超出工作区/);
  });

  it('⚠️ 空字节与超长路径被拒', () => {
    const root = makeWorkspace();
    expect(() => resolveInWorkspace('a\0b', root)).toThrow(/空字节/);
    expect(() => resolveInWorkspace('x'.repeat(5000), root)).toThrow(/太长/);
  });

  it('⚠️ 工作区根目录本身不能被当成目标文件', () => {
    const root = makeWorkspace();
    expect(() => resolveInWorkspace('.', root)).toThrow(/根目录/);
  });

  it('⚠️ 工作区根目录不可删', () => {
    const root = makeWorkspace();
    expect(() => assertNotWorkspaceRoot(root, root)).toThrow(/根目录/);
    expect(() => assertNotWorkspaceRoot(join(root, 'a.txt'), root)).not.toThrow();
  });

  it('前缀相同但不在里面 → 不算在内', () => {
    expect(isInside('/tmp/workspace', '/tmp/workspace-evil/file')).toBe(false);
    expect(isInside('/tmp/workspace', '/tmp/workspace/file')).toBe(true);
    expect(isInside('/tmp/workspace', '/tmp/workspace')).toBe(true);
  });

  it('给模型看的是工作区内的相对路径', () => {
    const root = makeWorkspace();
    expect(toWorkspaceRelative(join(root, 'sub', 'b.txt'), root)).toBe('sub/b.txt');
  });
});
