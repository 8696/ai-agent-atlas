import { Op, QueryTypes, Sequelize } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import { nanoid } from 'nanoid';
import { sequelize } from '../db.js';
import { Message } from '../models/message.model.js';
import { Session } from '../models/session.model.js';
import { utcDaysAgo, utcNow, utcToIso } from '../lib/time.js';
import { clearPending } from './pending-confirm.js';
import { DEFAULT_TITLE } from '../lib/session-title.js';

/**
 * 会话服务 —— [12-b B2](../docs/12-b-需求-对话与编排.md) 的业务层。
 *
 * 📌 **网关只做参数校验与状态码**，业务规则都在这里。
 *
 * ⚠️ **单用户本地、无鉴权** —— 没有 `user_id` 过滤（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 */

export { DEFAULT_TITLE, TITLE_MAX_LENGTH, deriveTitle } from '../lib/session-title.js';

/** 对外暴露的会话视图（**时间统一给 ISO** —— 前端不认 UTC 墙钟） */
export interface SessionView {
  id: string;
  title: string;
  status: string;
  favorite: boolean;
  messageCount: number;
  lastActiveAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function toView(session: Session): SessionView {
  return {
    id: session.id,
    title: session.title || DEFAULT_TITLE,
    status: session.status,
    favorite: session.favorite === 1,
    messageCount: session.message_count,
    lastActiveAt: utcToIso(session.last_active_at),
    createdAt: utcToIso(session.created_at),
    updatedAt: utcToIso(session.updated_at),
  };
}

/** 新建会话（**`thread_id` = 会话 id** —— LangGraph 的 thread 就是会话） */
export async function createSession(input?: { title?: string }): Promise<Session> {
  const now = utcNow();
  const id = nanoid();
  return Session.create({
    id,
    title: input?.title?.trim() || '',
    status: 'active',
    favorite: 0,
    summary: null,
    metadata: null,
    thread_id: id,
    message_count: 0,
    last_active_at: now,
    created_at: now,
    updated_at: now,
  });
}

/** 取会话（找不到返回 null） */
export async function findSession(id: string): Promise<Session | null> {
  return Session.findByPk(id);
}

/** 取会话视图（找不到返回 null） */
export async function getSessionView(id: string): Promise<SessionView | null> {
  const session = await findSession(id);
  return session ? toView(session) : null;
}

export interface ListSessionsParams {
  /** 标题关键词 */
  query?: string | undefined;
  /** 只看收藏（会话级收藏 **或** 里有消息级收藏） */
  favoriteOnly?: boolean | undefined;
  /** 从 1 开始 */
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface ListSessionsResult {
  items: SessionView[];
  /** ⚠️ **筛选后的总数** —— 不是全库总数（见 [04-b §4.3](../docs/04-b-ui-聊天页.md)） */
  total: number;
  page: number;
  pageSize: number;
}

/** 列表默认每页条数 */
export const DEFAULT_PAGE_SIZE = 20;

/** 列表最大每页条数（防一次拉爆） */
export const MAX_PAGE_SIZE = 100;

export async function listSessions(params: ListSessionsParams = {}): Promise<ListSessionsResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));

  const conditions: WhereOptions[] = [];
  const keyword = params.query?.trim();
  if (keyword) {
    conditions.push({ title: { [Op.like]: `%${keyword}%` } });
  }
  if (params.favoriteOnly) {
    // ⚠️ **收藏 = 会话级收藏 或 里面有消息级收藏的会话**
    //    （见 [04-b §4.2](../docs/04-b-ui-聊天页.md)「只看收藏筛选同时看会话级与消息级」）
    conditions.push(
      Sequelize.or(
        { favorite: 1 },
        Sequelize.literal('id IN (SELECT session_id FROM messages WHERE favorite = 1)'),
      ),
    );
  }
  const where = conditions.length > 0 ? Sequelize.and(...conditions) : ({} as WhereOptions);

  const { rows, count } = await Session.findAndCountAll({
    where,
    order: [['last_active_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return { items: rows.map(toView), total: count, page, pageSize };
}

/** 改标题（**空标题 = 回到默认标题**） */
export async function renameSession(id: string, title: string): Promise<SessionView | null> {
  const session = await findSession(id);
  if (!session) return null;
  session.title = title.trim();
  session.updated_at = utcNow();
  await session.save();
  return toView(session);
}

/** 设收藏态（**`favorite` 传 undefined = 切换**） */
export async function setSessionFavorite(
  id: string,
  favorite?: boolean,
): Promise<SessionView | null> {
  const session = await findSession(id);
  if (!session) return null;
  session.favorite = favorite === undefined ? (session.favorite === 1 ? 0 : 1) : favorite ? 1 : 0;
  session.updated_at = utcNow();
  await session.save();
  return toView(session);
}

/** 表在不在（`tool_call_logs` / `graph_checkpoints` 由别的需求建） */
async function tableExists(table: string): Promise<boolean> {
  const rows = await sequelize.query<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = :name",
    { replacements: { name: table }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
}

/**
 * 删会话 —— **级联清干净，不留孤儿行**。
 *
 * ⚠️ **`tool_call_logs` / `graph_checkpoints` 是「表在就清」**：
 * 那两张表分别由工具流水（[C6](../docs/12-c-需求-工具技能与扩展.md)）与
 * 检查点（[B6](../docs/12-b-需求-对话与编排.md)）两条需求建 —— 现在还不存在，
 * 但**级联逻辑先写好**，等它们建了不用再改。
 */
export async function deleteSession(id: string): Promise<boolean> {
  const session = await findSession(id);
  if (!session) return false;

  // ⚠️ **挂起中的确认要清掉** —— 否则那个请求会一直等到超时
  clearPending(id);

  // ⚠️ **表存在性在事务外查** —— 事务里再发一次查询会二次占用连接
  //    （连接池 `max: 1`，多一次占用就多一份等锁的 risk）
  const hasToolLogs = await tableExists('tool_call_logs');
  const hasCheckpoints = await tableExists('graph_checkpoints');
  const hasCheckpointWrites = await tableExists('graph_checkpoint_writes');

  await sequelize.transaction(async (transaction) => {
    await Message.destroy({ where: { session_id: id }, transaction });

    if (hasToolLogs) {
      await sequelize.query('DELETE FROM tool_call_logs WHERE session_id = :id', {
        replacements: { id },
        transaction,
      });
    }
    if (hasCheckpointWrites) {
      // ⚠️ **待写入也要清** —— 它跟检查点是一对，清一半会留下孤儿行
      await sequelize.query('DELETE FROM graph_checkpoint_writes WHERE thread_id = :id', {
        replacements: { id },
        transaction,
      });
    }
    if (hasCheckpoints) {
      await sequelize.query('DELETE FROM graph_checkpoints WHERE thread_id = :id', {
        replacements: { id },
        transaction,
      });
    }

    await session.destroy({ transaction });
  });

  return true;
}

/** 刷新会话的活跃时间与消息计数（每轮对话结束后调） */
export async function touchSession(id: string): Promise<void> {
  const count = await Message.count({ where: { session_id: id } });
  await Session.update(
    { last_active_at: utcNow(), message_count: count, updated_at: utcNow() },
    { where: { id } },
  );
}

/**
 * 改会话的元数据（**合并，不是覆盖**）。
 *
 * 📌 **会话级设置走这里** —— 模型切换、思考开关、人格文件、
 * 摘要边界都存在 `sessions.metadata` 里（见 [12-b B9](../docs/12-b-需求-对话与编排.md)）。
 */
export async function updateSessionMetadata(
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const session = await findSession(id);
  if (!session) return null;

  let metadata: Record<string, unknown> = {};
  if (session.metadata) {
    try {
      metadata = JSON.parse(session.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  const merged = { ...metadata, ...patch };
  session.metadata = JSON.stringify(merged);
  session.updated_at = utcNow();
  await session.save();
  return merged;
}

/** 会话级设置 */
export interface SessionSettings {
  /** 本会话指定的模型（**没指定就用全局的**） */
  model?: string | undefined;
  /** 本会话的思考开关（**true / false / undefined = 跟着全局**） */
  thinking?: boolean | undefined;
  /** 本会话的人格文件（**SOUL.md 的文件名，不含路径**） */
  personality?: string | undefined;
  /** 摘要覆盖到哪条消息 */
  summaryBoundary?: string | undefined;
}

/** 读会话级设置 */
export async function getSessionSettings(id: string): Promise<SessionSettings> {
  const session = await findSession(id);
  if (!session) return {};
  let metadata: Record<string, unknown> = {};
  if (session.metadata) {
    try {
      metadata = JSON.parse(session.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  const settings: SessionSettings = {};
  if (typeof metadata['session_model'] === 'string') settings.model = metadata['session_model'];
  if (typeof metadata['thinking'] === 'boolean') settings.thinking = metadata['thinking'];
  if (typeof metadata['personality'] === 'string') {
    settings.personality = metadata['personality'];
  }
  if (typeof metadata['summary_boundary'] === 'string') {
    settings.summaryBoundary = metadata['summary_boundary'];
  }
  return settings;
}

/**
 * 保留期清理 —— 超过 `days` 天的会话连同消息一起清掉。
 *
 * ⚠️ **收藏的会话不清理** —— 收藏是「我还想留着它」的明确表态。
 * ⚠️ **表还不存在就直接跳过** —— 新机器上迁移还没跑，
 * 启动时不该甩一个「no such table」的错出来（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * @returns 删掉的会话数
 */
export async function purgeExpiredSessions(days: number): Promise<number> {
  if (days <= 0) return 0;
  if (!(await tableExists('sessions'))) return 0;
  const cutoff = utcDaysAgo(days);
  const expired = await Session.findAll({
    where: { last_active_at: { [Op.lt]: cutoff }, favorite: 0 },
    attributes: ['id'],
  });
  for (const session of expired) {
    await deleteSession(session.id);
  }
  return expired.length;
}
