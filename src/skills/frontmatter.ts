/**
 * frontmatter 解析 —— **只支持 agentskills.io 用到的那一小撮 YAML**
 * （见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **不引 YAML 依赖** —— 本项目只需要 `key: value` 这种最朴素的写法，
 * 多一个依赖就多一份升级负担（见 [03-a §A.2](./docs/03-a-技术栈-工程化规范.md)）。
 *
 * ⚠️ **未识别的行原样忽略** —— 解析器不该因为多了一行注释就整个失败。
 */

/** 解析结果 */
export interface Frontmatter {
  /** frontmatter 里的键值对（**值都是字符串**） */
  fields: Record<string, string>;
  /** 正文（frontmatter 之后的内容） */
  body: string;
  /** 有没有 frontmatter */
  hasFrontmatter: boolean;
}

/** 头部：`---` 起始，`---` 结束 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/** 键名允许的字符 */
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * 解析 frontmatter。
 *
 * ⚠️ **值里带 `#` 不当注释** —— 只有「行首就是 `#`」才算注释行。
 * 描述里出现 `#`（比如 `C#`）很常见，误当注释会把描述截断。
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { fields: {}, body: raw, hasFrontmatter: false };

  const block = match[1] ?? '';
  const body = raw.slice(match[0].length);
  const fields: Record<string, string> = {};

  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    // ⚠️ **空行与整行注释跳过**
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    if (!KEY_RE.test(key)) continue;

    let value = trimmed.slice(colon + 1).trim();
    // 📌 **成对的引号要剥掉** —— 描述里有冒号或 # 时要加引号
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  return { fields, body, hasFrontmatter: true };
}

/** 这个值要不要加引号 */
function needsQuote(value: string): boolean {
  return (
    value.includes(':') ||
    value.includes('#') ||
    value.includes('\n') ||
    value.startsWith(' ') ||
    value.endsWith(' ')
  );
}

/**
 * 渲染 frontmatter + 正文。
 *
 * 📌 **字段顺序固定** —— `name` · `description` · `version` · `enabled` ·
 * `sensitivity` · `autoCreated`，跟文档里写的格式一致（人能直接读懂）。
 */
export function renderFrontmatter(
  fields: Record<string, string | boolean | undefined>,
  body: string,
): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === 'boolean' ? String(value) : value;
    if (text.trim() === '') continue;
    lines.push(`${key}: ${needsQuote(text) ? JSON.stringify(text) : text}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${body.trim()}\n`;
}
