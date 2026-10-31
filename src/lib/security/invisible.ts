/**
 * 不可见字符检测 —— **零宽 / 双向控制 / BOM / 标签字符**。
 *
 * ⚠️ **这类字符能把文字「藏」起来** —— 肉眼看不见，
 *    但模型看得见、shell 也看得见 → 持久化内容里放一个就是一条暗道。
 *
 * 📌 **记忆与技能都用这一条**（见 [12-e E4](../../docs/12-e-需求-观测安全与验收.md)）：
 *    两者都是**持久化的注入通道**。
 */

/**
 * ⚠️ **用 `new RegExp` 拼** —— 直接写字符类的话，源码里会出现**真字符**：
 *    编辑器里看不见，复制粘贴还可能把它弄丢（`git diff` 也看不出改了啥）。
 *    这里写成转义序列，源码里一眼能看出范围。
 */
const INVISIBLE_RANGES = [
  '\\u200B-\\u200F', // 零宽空格 / 零宽连接 / 方向标记
  '\\u202A-\\u202E', // 双向文本嵌入 / 覆写
  '\\u2066-\\u2069', // 双向隔离符
  '\\uFEFF', // BOM / 零宽不换行空格
  '\\u{E0000}-\\u{E007F}', // 标签字符（Unicode 13 起的「不可见标签」）
].join('');

export const INVISIBLE_PATTERN = new RegExp(`[${INVISIBLE_RANGES}]`, 'u');

/** 这个字符串里有没有不可见字符 */
export function hasInvisibleChars(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  return INVISIBLE_PATTERN.test(text);
}
