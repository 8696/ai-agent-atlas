import { create } from 'zustand';
import {
  deleteSession as apiDeleteSession,
  fetchSessions,
  renameSession as apiRenameSession,
  toggleSessionFavorite as apiToggleFavorite,
  type SessionSummary,
} from '../api';

/**
 * 会话列表 store —— **侧栏与历史会话页共用**。
 *
 * ⚠️ **这里的 loading 与聊天面板的 loading 是两回事**：
 * 切「只看收藏」/ 改搜索词会重新拉列表，
 * 但**绝不能影响正在流式输出的那一轮**（见 [12-b B2](../../docs/12-b-需求-对话与编排.md)）。
 * 两边各用各的状态，互不干涉。
 *
 * 📌 **搜索与收藏筛选都在服务端做** —— 前端只发参数、收结果。
 */

interface SessionState {
  items: SessionSummary[];
  /** ⚠️ **筛选后的总数**（不是全库总数） */
  total: number;
  page: number;
  pageSize: number;
  /** 列表自己的 loading —— **与聊天流式状态无关** */
  loading: boolean;
  error: string | null;
  /** 标题关键词 */
  query: string;
  /** 只看收藏 */
  favoriteOnly: boolean;
  load: () => Promise<void>;
  setQuery: (query: string) => void;
  setFavoriteOnly: (favoriteOnly: boolean) => void;
  setPage: (page: number) => void;
  /** 收藏切换（**乐观更新 + 失败回滚**） */
  toggleFavorite: (id: string) => Promise<void>;
  /** 改名 */
  rename: (id: string, title: string) => Promise<void>;
  /** 删除 */
  remove: (id: string) => Promise<void>;
  /** 新建/更新后插到列表顶部 */
  upsert: (session: SessionSummary) => void;
  /** 会话被删掉后从列表里摘掉 */
  forget: (id: string) => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  error: null,
  query: '',
  favoriteOnly: false,

  load: async () => {
    const { query, favoriteOnly, page, pageSize } = get();
    set({ loading: true, error: null });
    try {
      const data = await fetchSessions({ q: query, favorite: favoriteOnly, page, pageSize });
      set({ items: data.items, total: data.total, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '会话列表拉取失败',
      });
    }
  },

  setQuery: (query) => {
    // ⚠️ **改关键词回到第 1 页** —— 留着第 3 页的页码在新结果里多半是空的
    set({ query, page: 1 });
    void get().load();
  },

  setFavoriteOnly: (favoriteOnly) => {
    set({ favoriteOnly, page: 1 });
    void get().load();
  },

  setPage: (page) => {
    set({ page });
    void get().load();
  },

  toggleFavorite: async (id) => {
    const before = get().items;
    // ⚠️ **乐观更新** —— 收藏是个小开关，等网络往返会让界面「粘手」
    set({
      items: before.map((item) => (item.id === id ? { ...item, favorite: !item.favorite } : item)),
    });
    try {
      const updated = await apiToggleFavorite(id);
      set({ items: get().items.map((item) => (item.id === id ? updated : item)) });
      // ⚠️ **收藏筛选开着时，取消收藏的会话要从列表里消失**
      if (get().favoriteOnly && !updated.favorite) {
        void get().load();
      }
    } catch (err) {
      set({ items: before, error: err instanceof Error ? err.message : '收藏失败' });
    }
  },

  rename: async (id, title) => {
    const before = get().items;
    set({ items: before.map((item) => (item.id === id ? { ...item, title } : item)) });
    try {
      const updated = await apiRenameSession(id, title);
      set({ items: get().items.map((item) => (item.id === id ? updated : item)) });
    } catch (err) {
      set({ items: before, error: err instanceof Error ? err.message : '改名失败' });
      throw err;
    }
  },

  remove: async (id) => {
    const before = get().items;
    set({ items: before.filter((item) => item.id !== id) });
    try {
      await apiDeleteSession(id);
      set({ total: Math.max(0, get().total - 1) });
    } catch (err) {
      set({ items: before, error: err instanceof Error ? err.message : '删除失败' });
      throw err;
    }
  },

  upsert: (session) => {
    const items = get().items;
    const exists = items.some((item) => item.id === session.id);
    set({
      items: exists
        ? items.map((item) => (item.id === session.id ? session : item))
        : [session, ...items],
      total: exists ? get().total : get().total + 1,
    });
  },

  forget: (id) => {
    const items = get().items;
    if (!items.some((item) => item.id === id)) return;
    set({ items: items.filter((item) => item.id !== id), total: Math.max(0, get().total - 1) });
  },
}));
