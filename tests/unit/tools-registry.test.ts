import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolConflictError, buildRegistry, mergeToolGroups } from '../../src/tools/registry';
import { keywordHit, scoreTool, selectTools, tokenize } from '../../src/tools/selection';
import { globToRegExp, matchesGlob } from '../../src/tools/glob';
import type { ToolDefinition } from '../../src/tools/types';
import type { Env } from '../../src/config/schema';

/**
 * 工具注册表与裁剪的单元测试 —— **纯函数，不碰配置**。
 *
 * 覆盖：工具名冲突 · 停用的工具不进池 · 按相关度裁剪 · glob 匹配。
 */

function makeTool(name: string, sensitivity: ToolDefinition['sensitivity'] = 'normal'): ToolDefinition {
  return {
    name,
    description: `工具 ${name} 的说明`,
    schema: z.object({}),
    sensitivity,
    source: 'builtin',
    enabled: true,
    executor: 'local',
    invoke: () => Promise.resolve({ ok: true, output: '' }),
  };
}

describe('工具注册表', () => {
  it('⚠️ 两个内置工具重名 → 启动失败（不静默覆盖）', () => {
    expect(() =>
      mergeToolGroups([
        { source: 'builtin', tools: [makeTool('dup')] },
        { source: 'builtin', tools: [makeTool('dup')] },
      ]),
    ).toThrow(ToolConflictError);
  });

  it('⚠️ 第三方来源重名 → 改名注册（不覆盖内置）', () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('dup')] },
      {
        source: 'skill',
        tools: [{ ...makeTool('dup'), source: 'skill' }],
      },
    ]);
    expect(merged.map((tool) => tool.name)).toEqual(['dup', 'skill__dup']);
  });

  it('改名后仍然撞名 → 那个工具不注册', () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('dup')] },
      { source: 'skill', tools: [{ ...makeTool('dup'), source: 'skill' }] },
      { source: 'skill', tools: [{ ...makeTool('dup'), source: 'skill' }] },
    ]);
    expect(merged.map((tool) => tool.name)).toEqual(['dup', 'skill__dup']);
  });

  it('注册表能按名字取工具', () => {
    const registry = buildRegistry([{ source: 'builtin', tools: [makeTool('alpha')] }]);
    expect(registry.get('alpha')?.name).toBe('alpha');
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.names()).toEqual(['alpha']);
  });

  it('默认注册表里有内置工具（**含文件与命令**）', () => {
    const registry = buildRegistry();
    const names = registry.names();
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_dir');
    expect(names).toContain('shell');
    expect(names).toContain('http_request');
    expect(names).toContain('current_time');
    // 📌 **记忆工具也在池子里** —— 对话里要能增删改记忆
    expect(names).toContain('memory');
    expect(names).toContain('memory_forget');
  });
});

describe('工具池裁剪', () => {
  it('中文按二元组切词', () => {
    expect(tokenize('读取文件')).toContain('读取');
    expect(tokenize('read file')).toContain('read');
  });

  it('相关度：问「列目录」时 list_dir 得分更高', () => {
    const listDir = makeTool('list_dir');
    listDir.description = '列出目录里的内容';
    const shell = makeTool('shell');
    shell.description = '执行一条 shell 命令';
    expect(scoreTool(listDir, '帮我列一下目录')).toBeGreaterThan(scoreTool(shell, '帮我列一下目录'));
  });

  it('⚠️ 超过上限 → 高危工具按相关度裁掉，基础工具保留', () => {
    const tools = [
      makeTool('list_dir', 'low'),
      makeTool('read_file', 'normal'),
      makeTool('delete_path', 'high'),
      makeTool('write_file', 'high'),
      makeTool('shell', 'high'),
    ];
    const picked = selectTools(tools, '读取文件', { MAX_TOOLS_PER_TURN: 3 } as Env);
    expect(picked).toHaveLength(3);
    expect(picked.map((tool) => tool.name)).toContain('list_dir');
    expect(picked.map((tool) => tool.name)).toContain('read_file');
  });

  it('工具不够多时原样返回', () => {
    const tools = [makeTool('a'), makeTool('b')];
    expect(selectTools(tools, '随便', { MAX_TOOLS_PER_TURN: 12 } as Env)).toHaveLength(2);
  });
});

describe('关键词强制保留（[12-c C1](../docs/12-c-需求-工具技能与扩展.md)）', () => {
  /** 造一个带关键词的工具 */
  function makeKeywordTool(
    name: string,
    keywords: string[] | undefined,
    groups: string[][] | undefined = undefined,
    sensitivity: ToolDefinition['sensitivity'] = 'high',
  ): ToolDefinition {
    return {
      ...makeTool(name, sensitivity),
      ...(keywords ? { keywords } : {}),
      ...(groups ? { keywordGroups: groups } : {}),
    };
  }

  it('⚠️ 命中关键词的高危工具 —— 哪怕只剩一个名额也要留下', () => {
    const tools = [
      makeKeywordTool('shell', ['跑', '执行', '测试']),
      makeKeywordTool('write_file', ['写']),
      makeKeywordTool('delete_path', ['删文件']),
      makeTool('a'),
      makeTool('b'),
    ];
    const picked = selectTools(tools, '跑一下测试', { MAX_TOOLS_PER_TURN: 3 } as Env);
    expect(picked.map((tool) => tool.name)).toContain('shell');
  });

  it('⚠️ 没命中关键词的高危工具仍按相关度抢名额', () => {
    const tools = [
      makeKeywordTool('shell', ['跑', '执行']),
      makeKeywordTool('write_file', ['写']),
      makeTool('a'),
      makeTool('b'),
    ];
    const picked = selectTools(tools, '跑一下测试', { MAX_TOOLS_PER_TURN: 3 } as Env);
    // ⚠️ **shell 靠关键词留下** —— 不是靠相关度
    expect(picked.map((tool) => tool.name)).toContain('shell');
    expect(picked).toHaveLength(3);
  });

  it('⚠️ 组合关键词 —— 「把那条记忆删掉」不该带出删文件的工具', () => {
    const forget = makeKeywordTool('memory_forget', undefined, [
      ['记忆', '偏好'],
      ['删', '清空', '忘'],
    ]);
    const remove = makeKeywordTool('delete_path', undefined, [
      ['删', '删除', '删掉', '清理', '移除'],
      ['文件', '目录', '文件夹', '路径', 'tmp', '临时', 'data'],
    ]);
    // 📌 **强制保留的判定** —— 用户想删的是记忆，不是文件
    expect(keywordHit(forget, '把那条记忆删掉')).toBe(true);
    expect(keywordHit(remove, '把那条记忆删掉')).toBe(false);
    // 📌 **真要删文件时才轮到 delete_path**
    expect(keywordHit(remove, '把 data/tmp 删掉')).toBe(true);
  });

  it('⚠️ ASCII 关键词按词边界 —— `ls` 不该命中 `list`', () => {
    const tool = makeKeywordTool('shell', ['ls']);
    expect(keywordHit(tool, '跑一下 list')).toBe(false);
    expect(keywordHit(tool, '跑一下 ls -la')).toBe(true);
  });

  it('中文关键词按子串', () => {
    const tool = makeKeywordTool('shell', ['跑']);
    expect(keywordHit(tool, '跑一下测试')).toBe(true);
    expect(keywordHit(tool, '测试一下')).toBe(false);
  });
});

describe('glob 匹配', () => {
  it('`*` 不跨目录', () => {
    expect(matchesGlob('a/b.ts', '*.ts')).toBe(false);
    expect(matchesGlob('b.ts', '*.ts')).toBe(true);
  });

  it('`**` 跨目录', () => {
    expect(matchesGlob('src/a/b.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('a/b.ts', 'a/**')).toBe(true);
  });

  it('`?` 匹配一个字符', () => {
    expect(matchesGlob('a1', 'a?')).toBe(true);
    expect(matchesGlob('a12', 'a?')).toBe(false);
  });

  it('正则里的点要转义', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});
