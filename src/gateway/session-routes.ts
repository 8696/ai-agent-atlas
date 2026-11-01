import Router from '@koa/router';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import {
  DEFAULT_PAGE_SIZE,
  createSession,
  deleteSession,
  getSessionView,
  listSessions,
  renameSession,
  setSessionFavorite,
} from '../services/session.js';
import { listMessages, setMessageFavorite } from '../services/message.js';
import { exportSession } from '../services/session-export.js';
import { readSessionLog } from '../services/turn-log/store.js';

/**
 * 会话网关 —— `/api/v1/sessions` · `/api/v1/messages/:id/favorite`
 * （见 [12-b B2](../docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **无鉴权**（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）——
 * 本地单用户，不做身份过滤。
 *
 * 📌 **网关只做「校验 + 状态码」**，业务规则在 `services/session.ts`。
 */

export const sessionRouter = new Router({ prefix: '/api/v1' });

const listQuerySchema = z.object({
  q: z.string().optional(),
  favorite: z.enum(['0', '1', 'true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const renameSchema = z.object({
  title: z.string().max(200),
});

const favoriteSchema = z.object({
  favorite: z.boolean().optional(),
});

/** 取路径参数（**缺了就 400** —— 路由匹配上了却没参数 = 有人在乱打） */
function pathParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new AppError('INVALID_REQUEST', `缺少路径参数 ${name}`, 400);
  }
  return value;
}

/**
 * `GET /api/v1/sessions` —— 列表（**分页 + 标题搜索 + 只看收藏，全在服务端筛**）。
 */
sessionRouter.get('/sessions', async (ctx) => {
  const parsed = listQuerySchema.safeParse(ctx.request.query);
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', '查询参数格式不对', 400);
  }
  const { q, favorite, page, pageSize } = parsed.data;
  const result = await listSessions({
    query: q,
    favoriteOnly: favorite === '1' || favorite === 'true',
    page,
    pageSize: pageSize ?? DEFAULT_PAGE_SIZE,
  });
  ctx.body = result;
});

/**
 * `POST /api/v1/sessions` —— 新建会话。
 *
 * ⚠️ **不传 body 也行** —— 前端在第一次发消息前先建一个空会话，
 * 拿到 id 之后把它带进聊天请求（这样刷新页面还能回到同一个会话）。
 */
sessionRouter.post('/sessions', async (ctx) => {
  const session = await createSession();
  ctx.status = 201;
  ctx.body = await getSessionView(session.id);
});

/**
 * `GET /api/v1/sessions/:id` —— 会话详情 + 消息（**刷新页面回填用**）。
 */
sessionRouter.get('/sessions/:id', async (ctx) => {
  const session = await getSessionView(pathParam(ctx.params.id, 'id'));
  if (!session) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }
  ctx.body = { session, messages: await listMessages(pathParam(ctx.params.id, 'id')) };
});

/**
 * `PATCH /api/v1/sessions/:id` —— 改名。
 */
sessionRouter.patch('/sessions/:id', async (ctx) => {
  const parsed = renameSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', '请求体格式不对（要 { title }）', 400);
  }
  const session = await renameSession(pathParam(ctx.params.id, 'id'), parsed.data.title);
  if (!session) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }
  ctx.body = session;
});

/**
 * `PATCH /api/v1/sessions/:id/favorite` —— 收藏。
 *
 * ⚠️ **不传 body = 切换**（见 [12-b B2](../docs/12-b-需求-对话与编排.md)）。
 */
sessionRouter.patch('/sessions/:id/favorite', async (ctx) => {
  const parsed = favoriteSchema.safeParse(ctx.request.body ?? {});
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', '请求体格式不对', 400);
  }
  const session = await setSessionFavorite(pathParam(ctx.params.id, 'id'), parsed.data.favorite);
  if (!session) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }
  ctx.body = session;
});

/**
 * `GET /api/v1/sessions/:id/export` —— **导出会话**（`?format=md|json`，默认 md）。
 *
 * 📌 **直接下载** —— 响应带 `Content-Disposition`，
 *    浏览器点开这个地址就能存下来。
 */
sessionRouter.get('/sessions/:id/export', async (ctx) => {
  const format = ctx.request.query['format'] === 'json' ? 'json' : 'md';
  const result = await exportSession(pathParam(ctx.params.id, 'id'), format);
  if (!result) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }
  ctx.set('Content-Type', result.mimeType);
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  ctx.body = result.content;
});

/**
 * `GET /api/v1/sessions/:id/log` —— **这个会话的全链路日志**
 * （见 [12-e E7](../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **一个会话一份日志** —— 按 `session_id` 把所有轮次与事件聚在一起。
 */
sessionRouter.get('/sessions/:id/log', async (ctx) => {
  const id = pathParam(ctx.params.id, 'id');
  const session = await getSessionView(id);
  if (!session) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }
  ctx.body = { session: { id: session.id, title: session.title }, ...(await readSessionLog(id)) };
});

/**
 * `DELETE /api/v1/sessions/:id` —— 删会话（**级联删消息，不留孤儿行**）。
 */
sessionRouter.delete('/sessions/:id', async (ctx) => {
  const ok = await deleteSession(pathParam(ctx.params.id, 'id'));
  if (!ok) {
    throw new AppError('SESSION_NOT_FOUND', '会话不存在了（可能已被删除）', 404);
  }
  ctx.status = 204;
  ctx.body = null;
});

/**
 * `PATCH /api/v1/messages/:id/favorite` —— 消息级收藏（**不传 body = 切换**）。
 *
 * 📌 **不写审计** —— 收藏是个人偏好，不是管理动作（见 [04-b §4.2](../docs/04-b-ui-聊天页.md)）。
 */
sessionRouter.patch('/messages/:id/favorite', async (ctx) => {
  const parsed = favoriteSchema.safeParse(ctx.request.body ?? {});
  if (!parsed.success) {
    throw new AppError('INVALID_REQUEST', '请求体格式不对', 400);
  }
  const message = await setMessageFavorite(pathParam(ctx.params.id, 'id'), parsed.data.favorite);
  if (!message) {
    throw new AppError('MESSAGE_NOT_FOUND', '消息不存在了', 404);
  }
  ctx.body = message;
});
