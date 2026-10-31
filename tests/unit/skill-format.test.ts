import { describe, expect, it } from 'vitest';
import { parseFrontmatter, renderFrontmatter } from '../../src/skills/frontmatter';
import { expandForTrigram, trigramPhrases } from '../../src/lib/text';

/**
 * 技能格式的单元测试 —— **纯函数，不碰配置与数据库**。
 *
 * 覆盖（[12-c C4](../docs/12-c-需求-工具技能与扩展.md)）：
 * - frontmatter 的解析与渲染（**没引号的 YAML 子集**）
 * - 二元组展开 —— **让 2 字中文词能被 trigram 搜到**
 */

/** 一份合法的 SKILL.md */
const SAMPLE = `---
name: weekly-report
description: 写周报时使用
version: 1
enabled: true
sensitivity: high
---

## 步骤

1. 汇总本周做过的事
2. 写成一页
`;

describe('frontmatter 解析', () => {
  it('能读出字段与正文', () => {
    const { fields, body, hasFrontmatter } = parseFrontmatter(SAMPLE);
    expect(hasFrontmatter).toBe(true);
    expect(fields['name']).toBe('weekly-report');
    expect(fields['description']).toBe('写周报时使用');
    expect(fields['sensitivity']).toBe('high');
    expect(body.trim().startsWith('## 步骤')).toBe(true);
  });

  it('没有 frontmatter → 全文都是正文', () => {
    const { fields, body, hasFrontmatter } = parseFrontmatter('# 就是正文');
    expect(hasFrontmatter).toBe(false);
    expect(fields).toEqual({});
    expect(body).toBe('# 就是正文');
  });

  it('整行注释跳过，行内的 # 不当注释', () => {
    const raw = '---\n# 这行是注释\ndescription: 用 C# 写脚本\n---\n正文';
    const { fields } = parseFrontmatter(raw);
    expect(fields['description']).toBe('用 C# 写脚本');
  });

  it('成对的引号会被剥掉', () => {
    const raw = '---\ndescription: "带: 冒号的值"\n---\n正文';
    const { fields } = parseFrontmatter(raw);
    expect(fields['description']).toBe('带: 冒号的值');
  });
});

describe('frontmatter 渲染', () => {
  it('渲染出来能再解析回去', () => {
    const text = renderFrontmatter(
      { name: 'weekly-report', description: '写周报时使用', enabled: true, autoCreated: true },
      '## 步骤\n\n1. 汇总',
    );
    const { fields, body } = parseFrontmatter(text);
    expect(fields['name']).toBe('weekly-report');
    expect(fields['enabled']).toBe('true');
    expect(fields['autoCreated']).toBe('true');
    expect(body.trim()).toBe('## 步骤\n\n1. 汇总');
  });

  it('值里有冒号要加引号', () => {
    const text = renderFrontmatter({ description: 'a: b' }, '正文');
    const { fields } = parseFrontmatter(text);
    expect(fields['description']).toBe('a: b');
  });

  it('空值不写进 frontmatter', () => {
    const text = renderFrontmatter({ name: 'x', version: '' }, '正文');
    expect(text).not.toContain('version:');
  });
});

describe('二元组展开（**让 2 字中文词能被 trigram 搜到**）', () => {
  it('中文切成二元组并用空格隔开', () => {
    expect(expandForTrigram('写周报时使用')).toBe('写周 周报 报时 时使 使用 ');
  });

  it('英文词整体保留', () => {
    expect(expandForTrigram('生成 PDF 报告')).toBe('pdf 生成 报告 ');
  });

  it('每个短语后面都带一个空格（**trigram 至少要 3 个字符**）', () => {
    const phrases = trigramPhrases('帮我写一份周报');
    expect(phrases).toContain('周报 ');
    expect(phrases).toContain('帮我 ');
    for (const phrase of phrases) {
      expect(phrase.length).toBeGreaterThanOrEqual(3);
      expect(phrase.endsWith(' ')).toBe(true);
    }
  });

  it('单个汉字 + 空格不足 3 字符 → 丢掉', () => {
    expect(trigramPhrases('我')).toEqual([]);
  });

  it('空查询没有短语', () => {
    expect(trigramPhrases('   ')).toEqual([]);
  });
});
