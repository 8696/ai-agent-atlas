import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  formatAgentsInstructions,
  renderTemplate,
} from '../../src/services/prompt';

/**
 * 上下文文件注入的单元测试（见 [12-a A4](../../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 覆盖：
 * - `{{agents}}` 占位符被替换成项目指令
 * - 没有项目指令 → 那一段不出现（不留空标题）
 * - 超长会截断，并**明说截断了**
 * - 未识别的占位符原样保留
 */

describe('项目指令（AGENTS.md）注入', () => {
  it('项目指令被拼成一段（含小标题）', () => {
    const section = formatAgentsInstructions('# 项目约定\n\n不要动生产库。', 8000);
    expect(section).toContain('## 项目指令（AGENTS.md）');
    expect(section).toContain('不要动生产库。');
  });

  it('⚠️ 文件不存在 → 空串（那一段整个不出现）', () => {
    expect(formatAgentsInstructions('', 8000)).toBe('');
    expect(formatAgentsInstructions('   \n  ', 8000)).toBe('');
  });

  it('⚠️ 超长 → 截断并明说截断了', () => {
    const long = 'x'.repeat(5000);
    const section = formatAgentsInstructions(long, 100);
    expect(section).toContain('已截断');
    expect(section).toContain('前 100 字');
    expect(section).toContain('全文共 5000 字');
    // 📌 **截断后的正文不长**
    expect(section.length).toBeLessThan(400);
  });

  it('没超长 → 不加截断说明', () => {
    const section = formatAgentsInstructions('短短一句话', 8000);
    expect(section).not.toContain('已截断');
  });
});

describe('系统提示词组装', () => {
  it('`{{agents}}` 被替换成项目指令', () => {
    const prompt = buildSystemPrompt({ agents: '## 项目指令（AGENTS.md）\n\n不准删数据。' });
    expect(prompt).toContain('不准删数据。');
    expect(prompt).not.toContain('{{agents}}');
  });

  it('没有项目指令 → 那一段不出现，也不留空标题', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain('{{agents}}');
    expect(prompt).not.toContain('## 项目指令');
  });

  it('⚠️ 未识别的占位符原样保留', () => {
    expect(renderTemplate('a {{foo}} b {{date}}', { date: '2026-10-31' })).toBe(
      'a {{foo}} b 2026-10-31',
    );
  });
});
