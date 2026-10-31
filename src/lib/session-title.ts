/**
 * 会话标题生成 —— **纯函数**（不碰配置、不碰数据库）。
 *
 * 📌 **单独成文件是为了能直接跑单元测试** ——
 * 放在 `services/session.ts` 里的话，import 它就会把整个配置与数据库链路拖进来。
 */

/** 标题长度上限（首条用户消息截断到这个字数） */
export const TITLE_MAX_LENGTH = 30;

/** 默认标题（还没发过消息的会话） */
export const DEFAULT_TITLE = '新对话';

/**
 * 从首条用户消息生成标题 —— **截断到 30 字**。
 *
 * ⚠️ **超长时截到 29 字 + 省略号** —— 总长正好 30，不越界。
 * ⚠️ **换行与连续空白压成一个空格** —— 标题是一行字，多行会撑破侧栏。
 */
export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return DEFAULT_TITLE;
  if (flat.length <= TITLE_MAX_LENGTH) return flat;
  return `${flat.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}
