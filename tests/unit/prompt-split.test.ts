import { describe, expect, it } from 'vitest';
import {
  buildAgentsToc,
  buildSystemPrompt,
  buildSystemPromptParts,
  formatAgentsInstructions,
  splitTemplate,
} from '../../src/services/prompt';

/**
 * **系统提示词拆段**的单元测试（见 [12-a A8](../../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 📌 **为什么要拆** ——
 * Anthropic 的提示词缓存是**前缀缓存**：
 * 从消息开头到 `cache_control` 块为止的内容必须**逐字节相同**才命中。
 * 以前整套提示词是一个块、断点打在末尾，
 * 于是每轮都变的 `{{tools}}` · `{{skills}}` · `{{memories}}` · `{{retrieval}}` ·
 * `{{summary}}` · `{{date}}` 把整个前缀作废 → **命中率恒为 0**。
 *
 * 覆盖：
 * - 含易变占位符的行 → 易变段；其余 → 稳定段
 * - 标题跟着它那一节走
 * - 稳定段里**不含**任何易变占位符（这才叫稳定）
 * - 完整提示词（`buildSystemPrompt`）与拆开再拼起来**内容一致**
 */

const TEMPLATE = `# 人格

固定的人设文字。

{{language}}

{{tool}}

{{agents}}

## 当前上下文

- 日期：{{date}}
- 可用工具：{{tools}}

{{skills}}

{{summary}}

{{memories}}

{{retrieval}}`;

describe('系统提示词拆段（提示词缓存的前提）', () => {
  it('含易变占位符的行归易变段，其余归稳定段', () => {
    const { stable, volatile } = splitTemplate(TEMPLATE);
    expect(stable).toContain('{{language}}');
    expect(stable).toContain('{{tool}}');
    expect(stable).toContain('{{agents}}');
    expect(volatile).toContain('{{date}}');
    expect(volatile).toContain('{{tools}}');
    expect(volatile).toContain('{{skills}}');
    expect(volatile).toContain('{{summary}}');
    expect(volatile).toContain('{{memories}}');
    expect(volatile).toContain('{{retrieval}}');
  });

  it('📌 **稳定段里不含任何易变占位符** —— 这才叫稳定', () => {
    const { stable } = splitTemplate(TEMPLATE);
    for (const key of ['{{date}}', '{{tools}}', '{{skills}}', '{{summary}}', '{{memories}}', '{{retrieval}}']) {
      expect(stable).not.toContain(key);
    }
  });

  it('📌 **标题跟着它那一节走** —— 易变那一节的标题进易变段', () => {
    const { stable, volatile } = splitTemplate(TEMPLATE);
    // 「## 当前上下文」那一节含易变占位符 → 标题归易变段
    expect(volatile).toContain('## 当前上下文');
    expect(stable).not.toContain('## 当前上下文');
    // 「# 人格」那一节全是稳定占位符 → 标题留在稳定段
    expect(stable).toContain('# 人格');
  });

  it('⚠️ 混在一节里的占位符 —— 含易变的那行整体归易变段', () => {
    const { stable, volatile } = splitTemplate('## 混合\n\n{{language}}\n{{date}}\n');
    expect(volatile).toContain('{{date}}');
    expect(stable).not.toContain('{{date}}');
  });

  it('📌 **拆开再拼回去 = 完整提示词**（内容不能少）', () => {
    const parts = buildSystemPromptParts({
      tools: 'read_file、shell',
      memories: '## 长期记忆\n- 记住 pnpm',
      skills: '## 可用技能\n- 某技能',
      summary: '## 会话摘要\n- 之前聊过 X',
      agents: '## 项目指令（AGENTS.md）\n\n不准删数据。',
    });
    const joined = [parts.stable, parts.volatile].filter(Boolean).join('\n\n---\n\n');
    const whole = buildSystemPrompt({
      tools: 'read_file、shell',
      memories: '## 长期记忆\n- 记住 pnpm',
      skills: '## 可用技能\n- 某技能',
      summary: '## 会话摘要\n- 之前聊过 X',
      agents: '## 项目指令（AGENTS.md）\n\n不准删数据。',
    });
    expect(joined).toBe(whole);
  });

  it('📌 **易变段里不残留未替换的占位符**', () => {
    const parts = buildSystemPromptParts({ tools: 'read_file', date: '2026-11-01' });
    expect(parts.volatile).not.toContain('{{date}}');
    expect(parts.volatile).not.toContain('{{tools}}');
    expect(parts.volatile).toContain('2026-11-01');
    expect(parts.volatile).toContain('read_file');
  });
});

describe('AGENTS.md 的章节目录（让被截掉的部分可达）', () => {
  const RAW = ['# AGENTS.md', '', '## 1. 项目是什么', '', '介绍文字。', '', '## 2. 协作模式', '', '规矩在这里。'].join(
    '\n',
  );

  it('目录列出各章节与**行号**（模型能直接 read_file 带 offset）', () => {
    const toc = buildAgentsToc(RAW);
    expect(toc).toContain('1. 项目是什么');
    expect(toc).toContain('2. 协作模式');
    expect(toc).toMatch(/第 \d+ 行/);
    // 📌 **一级标题（文件名本身）不入目录** —— 它没有信息量
    expect(toc).not.toContain('- AGENTS.md');
  });

  it('⚠️ 没有标题 → 空串（不加目录）', () => {
    expect(buildAgentsToc('就是一段普通文字，没有任何标题。')).toBe('');
  });

  it('📌 **文件远大于上限时才加目录**', () => {
    const big = `${RAW}\n${'x'.repeat(5000)}`;
    // 📌 **认目录要看标题** —— 截断提示里也有「目录」这两个字
    const TOC_HEADING = '### 目录（AGENTS.md 的全部章节）';
    // 上限 100 → 全文 5,000+ 远大于上限的两倍 → 加目录
    expect(formatAgentsInstructions(big, 100)).toContain(TOC_HEADING);
    // 上限 8000 → 没超长 → 整份注入，不加目录
    expect(formatAgentsInstructions(big, 8000)).not.toContain(TOC_HEADING);
    // 📌 **只超一点点 → 不加目录**（缺的那点不值 400 token）
    //    上限 200、正文约 250 字 → 超了（截断）但没到上限的两倍 → 不加目录
    expect(formatAgentsInstructions(`${RAW}${'x'.repeat(200)}`, 200)).not.toContain(TOC_HEADING);
  });
});
