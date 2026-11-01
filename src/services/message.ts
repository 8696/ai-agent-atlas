import { nanoid } from 'nanoid';
import { Message } from '../models/message.model.js';
import { Session } from '../models/session.model.js';
import { utcNow, utcToIso } from '../lib/time.js';
import { extractText } from './chat-messages.js';
import { deriveTitle } from './session.js';

/**
 * 消息服务 —— 消息与 `parts` 的落库（见 [12-b B2](../docs/12-b-需求-对话与编排.md)）。
 *
 * 📌 **「客户端是真相」的对账模型**：
 * 前端每次请求都带上完整历史，后端拿它跟库里的行对账 ——
 * 公共前缀保留、多的删掉、少的补上。
 * 这样「重新生成」（前端把那条 assistant 砍掉再重发）天然表现为「删掉多余的行」。
 */

/** 落库的 part（结构化卡片） */
export interface UiPart {
  type: string;
  text?: string;
  state?: string;
  /** 数据 part 的 id（**工具卡片靠它对齐**） */
  id?: string;
  /** 数据 part 的载荷（**工具卡片 / 待确认卡片**） */
  data?: unknown;
}

/** 前端发来的消息（AI SDK UI Message 的最小形状） */
export interface IncomingMessage {
  id?: string | undefined;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: string; text?: string | undefined }>;
}

/** 对外暴露的消息视图 */
export interface MessageView {
  id: string;
  role: string;
  content: string;
  parts: UiPart[];
  favorite: boolean;
  createdAt: string | null;
  /**
   * 消息元数据（`model` / `complete` / `interrupted` …）。
   *
   * 📌 **`complete: false` = 这一次没答完** —— 流被中断（刷新 / 停止 / 崩溃）
   * 时落下来的部分内容，界面上要标出来（见 [12-b B13](../docs/12-b-需求-对话与编排.md)）。
   */
  metadata: Record<string, unknown> | null;
}

/** JSON 解析失败时返回兜底值（**不让一行坏数据把整个会话读挂**） */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 取一条消息的纯文本 */
function textOf(parts: Array<{ type: string; text?: string | undefined }>): string {
  return extractText(parts);
}

/**
 * 两边说的是不是同一条消息。
 *
 * 📌 **id 对得上就是同一条** —— 内容可能因为「流式落库」而落后
 *    （库里存的是上一次快照，客户端手里是最新的一段）。
 *    ⚠️ **别因为内容不一致就把它当成「多出来的行」删掉** ——
 *    那会把刚写进去的回答删掉（见 [12-b B13](../docs/12-b-需求-对话与编排.md)）。
 *    没有 id 时才退回比内容。
 */
function sameContent(row: Message, incoming: IncomingMessage): boolean {
  const id = incoming.id?.trim();
  if (id && row.id === id) return true;
  return row.role === incoming.role && row.content === textOf(incoming.parts);
}

/** 插入一条消息行（**客户端给了 id 就用它的** —— 两边对得上，收藏才点得中） */
async function insertRow(sessionId: string, incoming: IncomingMessage): Promise<void> {
  const now = utcNow();
  const id = incoming.id?.trim() || nanoid();
  const values = {
    session_id: sessionId,
    role: incoming.role,
    content: textOf(incoming.parts),
    parts: JSON.stringify(incoming.parts),
    tool_calls: null,
    tool_results: null,
    attachments: null,
    updated_at: now,
  };

  // ⚠️ **id 撞了就改那一行，不要炸** ——
  //    `create` 撞主键会抛「唯一约束冲突」，整个聊天请求就 500 了。
  //    同一个 id 再来一次，说明是同一条消息被重发 → 更新它。
  const existing = await Message.findByPk(id);
  if (existing) {
    existing.set(values);
    // ⚠️ **别把 metadata 抹成 null** —— 库里存着「这一轮没答完 / 模型名」这类
    //    服务端才知道的标记（见 [12-b B13](../docs/12-b-需求-对话与编排.md)）；
    //    「对账」重插这条行时不能把它清掉。
    await existing.save();
    return;
  }

  await Message.create({
    id,
    ...values,
    metadata: null,
    favorite: 0,
    created_at: now,
  });
}

/**
 * 用前端带来的历史对账。
 *
 * ⚠️ **删多补少** —— 这不是「追加」，是「对齐」。
 * 前端砍掉了某条 assistant 再重发（重新生成），库里那条就得跟着消失，
 * 否则刷新后会出现两条一样的回答。
 */
export async function syncMessages(sessionId: string, incoming: IncomingMessage[]): Promise<void> {
  const rows = await Message.findAll({
    where: { session_id: sessionId },
    order: [['created_at', 'ASC']],
  });

  let common = 0;
  while (
    common < rows.length &&
    common < incoming.length &&
    sameContent(rows[common] as Message, incoming[common] as IncomingMessage)
  ) {
    // 📌 **同一条消息但内容更长（客户端那份更全）→ 用更全的那份** ——
    //    流式落库时库里是快照，客户端手里是最新的一段；
    //    两边都是同一条流的**前缀**，取长的那个不会出错。
    const row = rows[common] as Message;
    const incomingMessage = incoming[common] as IncomingMessage;
    const incomingContent = textOf(incomingMessage.parts);
    if (incomingContent.length > row.content.length) {
      row.content = incomingContent;
      row.parts = JSON.stringify(incomingMessage.parts);
      row.updated_at = utcNow();
      await row.save();
    }
    common += 1;
  }

  if (rows.length > common) {
    const stale = rows.slice(common).map((row) => row.id);
    await Message.destroy({ where: { id: stale } });
  }

  for (const message of incoming.slice(common)) {
    await insertRow(sessionId, message);
  }
}

/**
 * 追加一条用户消息（**定时任务用** —— 没有前端参与，对账模型用不上）。
 *
 * ⚠️ **只追加、不对账** —— 调用方（定时任务）自己管历史。
 */
export async function appendUserMessage(sessionId: string, content: string): Promise<string> {
  const id = nanoid();
  await insertRow(sessionId, {
    id,
    role: 'user',
    parts: [{ type: 'text', text: content }],
  });
  return id;
}

/**
 * 追加一条 assistant 消息（**流结束后调**）。
 *
 * ⚠️ **`parts` 与推给前端的是同一份** —— 都来自同一批 chunk（见 [12-b B1](../docs/12-b-需求-对话与编排.md)）。
 * ⚠️ **`id` 用服务端生成的那个** —— 前端 `start` chunk 拿到的就是它，两边对得上。
 *
 * 📌 **同 id 就更新** —— 挂起时先落一笔（带待确认卡片），
 * 恢复后再落一次（带最终内容），两次是同一条消息，不会多出一条。
 *
 * @param createIfMissing **库里没有这行时要不要新建** ——
 *   流式落过库的行传 `false`：**「重新生成」把旧行删掉后，
 *   上一轮的收尾就不能再把它建回来**（否则会多出一条一样的回答）。
 */
export async function appendAssistantMessage(
  sessionId: string,
  input: {
    id: string;
    content: string;
    parts: UiPart[];
    metadata?: Record<string, unknown> | undefined;
    createIfMissing?: boolean | undefined;
  },
): Promise<void> {
  const now = utcNow();
  const values = {
    session_id: sessionId,
    role: 'assistant',
    content: input.content,
    parts: JSON.stringify(input.parts),
    tool_calls: null,
    tool_results: null,
    attachments: null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    updated_at: now,
  };

  const existing = await Message.findByPk(input.id);
  if (existing) {
    existing.set(values);
    await existing.save();
    return;
  }

  // 📌 **不新建就到此为止** —— 这行被「重新生成」删掉了，别复活它
  if (input.createIfMissing === false) return;

  await Message.create({
    id: input.id,
    ...values,
    favorite: 0,
    created_at: now,
  });
}

/** 读会话的消息（**按时间正序** —— 聊天区从上往下） */
export async function listMessages(sessionId: string): Promise<MessageView[]> {
  const rows = await Message.findAll({
    where: { session_id: sessionId },
    order: [['created_at', 'ASC']],
  });
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    parts: parseJson<UiPart[]>(row.parts, []),
    favorite: row.favorite === 1,
    createdAt: utcToIso(row.created_at),
    metadata: parseJson<Record<string, unknown> | null>(row.metadata, null),
  }));
}

/** 消息级收藏（**传 undefined = 切换**） */
export async function setMessageFavorite(
  messageId: string,
  favorite?: boolean,
): Promise<MessageView | null> {
  const row = await Message.findByPk(messageId);
  if (!row) return null;
  row.favorite = favorite === undefined ? (row.favorite === 1 ? 0 : 1) : favorite ? 1 : 0;
  row.updated_at = utcNow();
  await row.save();
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    parts: parseJson<UiPart[]>(row.parts, []),
    favorite: row.favorite === 1,
    createdAt: utcToIso(row.created_at),
    metadata: parseJson<Record<string, unknown> | null>(row.metadata, null),
  };
}

/**
 * 首条用户消息 → 会话标题（**只在标题还是空的时候写**）。
 *
 * ⚠️ **手动改过的标题不能被覆盖** —— 用户的心血不该被下一条消息冲掉。
 */
export async function applyTitleFromFirstUserMessage(sessionId: string): Promise<void> {
  const session = await Session.findByPk(sessionId);
  if (!session || session.title.trim() !== '') return;

  const first = await Message.findOne({
    where: { session_id: sessionId, role: 'user' },
    order: [['created_at', 'ASC']],
  });
  if (!first) return;

  session.title = deriveTitle(first.content);
  session.updated_at = utcNow();
  await session.save();
}
