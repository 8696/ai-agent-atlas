import axios from 'axios';

/**
 * REST 客户端 —— **一个 axios 实例**，baseURL `/api/v1`。
 *
 * ⚠️ **没有鉴权头、没有 401 拦截** —— 服务端完全免鉴权（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 * ⚠️ **SSE 不用它** —— SSE 走 `useChat` 的 transport（fetch + ReadableStream）。
 */

export const api = axios.create({
  baseURL: '/api/v1',
  timeout: 10_000,
});

/** 可用模型 */
export interface ModelInfo {
  name: string;
  role: 'primary' | 'fallback';
}

export interface ModelsResponse {
  /** 配没配模型 */
  configured: boolean;
  models: ModelInfo[];
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
}

/** 当前可用模型（**不回显 API Key**） */
export async function fetchModels(): Promise<ModelsResponse> {
  const { data } = await api.get<ModelsResponse>('/models');
  return data;
}

/** 后端健康检查 */
export async function fetchHealth(): Promise<HealthResponse> {
  const { data } = await api.get<HealthResponse>('/health');
  return data;
}

/* ── 会话（见 [12-b B2](../../docs/12-b-需求-对话与编排.md)） ───────────────── */

/** 会话摘要（**列表项与详情共用**） */
export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  /** 会话级收藏 */
  favorite: boolean;
  messageCount: number;
  lastActiveAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 落库的 part（结构化卡片；工具卡片也走这里） */
export interface StoredPart {
  type: string;
  text?: string;
  state?: string;
  id?: string;
  /** 数据 part 的载荷（**工具卡片 / 待确认卡片**） */
  data?: unknown;
}

/** 一条消息 */
export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  parts: StoredPart[];
  /** 消息级收藏 */
  favorite: boolean;
  createdAt: string | null;
}

/** 列表响应 */
export interface SessionListResponse {
  items: SessionSummary[];
  /** ⚠️ **筛选后的总数** —— 不是全库总数 */
  total: number;
  page: number;
  pageSize: number;
}

/** 详情响应 */
export interface SessionDetailResponse {
  session: SessionSummary;
  messages: StoredMessage[];
}

export interface SessionQuery {
  /** 标题关键词 */
  q?: string;
  /** 只看收藏 */
  favorite?: boolean;
  page?: number;
  pageSize?: number;
}

/** 会话列表（**搜索与收藏筛选都在服务端做**） */
export async function fetchSessions(query: SessionQuery = {}): Promise<SessionListResponse> {
  const { data } = await api.get<SessionListResponse>('/sessions', {
    params: {
      ...(query.q ? { q: query.q } : {}),
      ...(query.favorite ? { favorite: '1' } : {}),
      ...(query.page ? { page: query.page } : {}),
      ...(query.pageSize ? { pageSize: query.pageSize } : {}),
    },
  });
  return data;
}

/** 新建会话（**空会话，标题等第一条消息落库时再定**） */
export async function createSession(): Promise<SessionSummary> {
  const { data } = await api.post<SessionSummary>('/sessions');
  return data;
}

/** 会话详情 + 消息（**刷新页面回填用**） */
export async function fetchSession(id: string): Promise<SessionDetailResponse> {
  const { data } = await api.get<SessionDetailResponse>(`/sessions/${id}`);
  return data;
}

/** 改名 */
export async function renameSession(id: string, title: string): Promise<SessionSummary> {
  const { data } = await api.patch<SessionSummary>(`/sessions/${id}`, { title });
  return data;
}

/** 收藏（**不传 `favorite` = 切换**） */
export async function toggleSessionFavorite(
  id: string,
  favorite?: boolean,
): Promise<SessionSummary> {
  const { data } = await api.patch<SessionSummary>(`/sessions/${id}/favorite`, {
    ...(favorite === undefined ? {} : { favorite }),
  });
  return data;
}

/** 删会话（**级联删消息**） */
export async function deleteSession(id: string): Promise<void> {
  await api.delete(`/sessions/${id}`);
}

/** 消息级收藏（**不传 `favorite` = 切换**） */
export async function toggleMessageFavorite(
  id: string,
  favorite?: boolean,
): Promise<StoredMessage> {
  const { data } = await api.patch<StoredMessage>(`/messages/${id}/favorite`, {
    ...(favorite === undefined ? {} : { favorite }),
  });
  return data;
}

/* ── 斜杠命令（见 [12-b B9](../../docs/12-b-需求-对话与编排.md)） ───────────────── */

/** 一条命令的说明 */
export interface CommandInfo {
  /** 命令名（不含斜杠） */
  name: string;
  /** 用法 */
  usage: string;
  /** 一句话说明 */
  summary: string;
}

/** 命令清单响应（**前端补全用**） */
export interface CommandsResponse {
  commands: CommandInfo[];
  /** 已安装的技能名 */
  skills: string[];
  /** 可用的人格文件 */
  personalities: string[];
}

/**
 * 拉命令清单（**只用来做补全** —— 命令在服务端解析）。
 */
export async function fetchCommands(): Promise<CommandsResponse> {
  const { data } = await api.get<CommandsResponse>('/commands');
  return data;
}

/* ── 人工确认闸（见 [12-b B5](../../docs/12-b-需求-对话与编排.md)） ───────────── */

/** 确认结果 */
export interface ConfirmResponse {
  ok: boolean;
  /**
   * - `resumed` —— **原来的流还在跑**，批准后它会接着往下流
   * - `completed` —— **后端重启过**，这次已经把剩下的跑完了（`parts` 是结果）
   */
  mode: 'resumed' | 'completed';
  text?: string;
  parts?: StoredPart[];
}

/**
 * 批准 / 取消一次危险操作。
 *
 * ⚠️ **超时给长一点** —— `completed` 那条路要把剩下的对话跑完。
 *
 * 📌 **`fingerprint` 是入参指纹** —— 后端拿它核对「批准的是不是这一组参数」，
 * 对不上就重新弹确认（见 [12-b B5](../../docs/12-b-需求-对话与编排.md)）。
 */
export async function confirmToolCall(
  sessionId: string,
  approved: boolean,
  fingerprint?: string,
): Promise<ConfirmResponse> {
  const { data } = await api.post<ConfirmResponse>(
    '/chat/confirm',
    { sessionId, approved, ...(fingerprint ? { fingerprint } : {}) },
    { timeout: 180_000 },
  );
  return data;
}
