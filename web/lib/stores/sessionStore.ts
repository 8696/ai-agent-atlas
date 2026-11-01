import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  deleteSession as apiDeleteSession,
  fetchSessions,
  renameSession as apiRenameSession,
  toggleSessionFavorite as apiToggleFavorite,
  type SessionSummary,
} from '../api';

/**
 * 会话列表 store —— **侧栏一份、历史会话页一份，两份互不影响**。
 *
 * ⚠️ **为什么拆成两个**（这是踩过的坑）：
 * 之前侧栏与历史会话页**共用同一个 store**，于是：
 * 在历史会话页翻到第 2 页 / 改搜索词 / 切「只看收藏」
 * → 直接改掉侧栏那份状态 → **侧栏「今天」的列表被换掉了**。
 * 现在侧栏是**独立的一份**（永远是最近 20 条 + 第 1 页），
 * 翻历史页只动历史页那份。
 *
 * ⚠️ **但改名/收藏/删除要同步到两份** —— 在历史会话页改了标题，
 * 侧栏那份也得跟着改，否则两处显示不一致。
 * 所以这几个动作走 `broadcast()`：**一次改动，广播给所有列表**。
 *
 * ⚠️ **这里的 loading 与聊天面板的 loading 是两回事**：
 * 切「只看收藏」/ 改搜索词会重新拉列表，
 * 但**绝不能影响正在流式输出的那一轮**（见 [12-b B2](../../docs/12-b-需求-对话与编排.md)）。
 * 两边各用各的状态，互不干涉。
 *
 * 📌 **搜索与收藏筛选都在服务端做** —— 前端只发参数、收结果。
 */

export interface SessionListState {
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

type SessionListStore = UseBoundStore<StoreApi<SessionListState>>;

/** 已注册的所有列表 store —— **改动要广播给每一个** */
const registry = new Set<SessionListStore>();

/**
 * 把一个补丁广播给所有列表 store。
 * 补丁函数拿到该 store 的当前状态，返回要改的字段；返回 `null` = 这份列表不用改。
 */
function broadcast(patch: (state: SessionListState) => Partial<SessionListState> | null): void {
  for (const store of registry) {
    const next = patch(store.getState());
    if (next) store.setState(next);
  }
}

/** 这份列表当前是不是「收着」这个会话（搜索词 / 收藏筛选） */
function matchesFilters(state: SessionListState, session: SessionSummary): boolean {
  if (state.query && !session.title.includes(state.query)) return false;
  if (state.favoriteOnly && !session.favorite) return false;
  return true;
}

/* ── 跨列表的动作（广播） ───────────────────────────────────────────────── */

/** 收藏切换 —— **乐观更新 + 失败回滚** */
async function toggleFavorite(id: string): Promise<void> {
  // 📌 **先记下原值** —— 失败要能回滚
  const before = new Map<string, boolean>();
  for (const store of registry) {
    const hit = store.getState().items.find((item) => item.id === id);
    if (hit) before.set(id, hit.favorite);
  }
  const next = !before.get(id);

  broadcast((state) => {
    if (!state.items.some((item) => item.id === id)) return null;
    // ⚠️ **收藏筛选开着时，取消收藏的会话要从列表里消失**
    if (state.favoriteOnly && !next) {
      return {
        items: state.items.filter((item) => item.id !== id),
        total: Math.max(0, state.total - 1),
      };
    }
    return {
      items: state.items.map((item) => (item.id === id ? { ...item, favorite: next } : item)),
    };
  });

  try {
    const updated = await apiToggleFavorite(id);
    broadcast((state) => ({
      items: state.items.map((item) => (item.id === id ? updated : item)),
    }));
  } catch (err) {
    broadcast((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, favorite: before.get(id) ?? item.favorite } : item,
      ),
      error: err instanceof Error ? err.message : '收藏失败',
    }));
  }
}

/** 改名 —— **乐观更新 + 失败回滚** */
async function rename(id: string, title: string): Promise<void> {
  broadcast((state) => ({
    items: state.items.map((item) => (item.id === id ? { ...item, title } : item)),
  }));
  try {
    const updated = await apiRenameSession(id, title);
    broadcast((state) => ({
      items: state.items.map((item) => (item.id === id ? updated : item)),
    }));
  } catch (err) {
    broadcast(() => ({ error: err instanceof Error ? err.message : '改名失败' }));
    // 📌 **回滚** —— 重新拉一次最稳（别的字段也可能变了）
    for (const store of registry) void store.getState().load();
    throw err;
  }
}

/** 删除 */
async function remove(id: string): Promise<void> {
  // 📌 **留个快照** —— 失败要能还原
  const snapshots = new Map<SessionListStore, { items: SessionSummary[]; total: number }>();
  for (const store of registry) {
    const state = store.getState();
    snapshots.set(store, { items: state.items, total: state.total });
  }

  broadcast((state) => {
    if (!state.items.some((item) => item.id === id)) return null;
    return {
      items: state.items.filter((item) => item.id !== id),
      total: Math.max(0, state.total - 1),
    };
  });

  try {
    await apiDeleteSession(id);
  } catch (err) {
    for (const [store, snap] of snapshots) {
      store.setState({ items: snap.items, total: snap.total, error: err instanceof Error ? err.message : '删除失败' });
    }
    throw err;
  }
}

/** 新建/更新后插到列表顶部 */
function upsert(session: SessionSummary): void {
  broadcast((state) => {
    // ⚠️ **不匹配当前筛选的会话就别插** —— 否则搜索结果里会冒出一条不相关的
    if (!matchesFilters(state, session)) return null;
    const exists = state.items.some((item) => item.id === session.id);
    return {
      items: exists
        ? state.items.map((item) => (item.id === session.id ? session : item))
        : [session, ...state.items],
      total: exists ? state.total : state.total + 1,
    };
  });
}

/** 会话被删掉后从列表里摘掉 */
function forget(id: string): void {
  broadcast((state) => {
    if (!state.items.some((item) => item.id === id)) return null;
    return {
      items: state.items.filter((item) => item.id !== id),
      total: Math.max(0, state.total - 1),
    };
  });
}

/* ── store 工厂 ──────────────────────────────────────────────────────────── */

function createSessionListStore(pageSize: number): SessionListStore {
  const store = create<SessionListState>()((set, get) => ({
    items: [],
    total: 0,
    page: 1,
    pageSize,
    loading: false,
    error: null,
    query: '',
    favoriteOnly: false,

    load: async () => {
      const { query, favoriteOnly, page, pageSize: size } = get();
      set({ loading: true, error: null });
      try {
        const data = await fetchSessions({ q: query, favorite: favoriteOnly, page, pageSize: size });
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

    toggleFavorite: (id) => toggleFavorite(id),
    rename: (id, title) => rename(id, title),
    remove: (id) => remove(id),
    upsert: (session) => upsert(session),
    forget: (id) => forget(id),
  }));

  registry.add(store);
  return store;
}

/**
 * 侧栏那份列表 —— **永远是最近 20 条、第 1 页**。
 *
 * 📌 **不受历史会话页影响** —— 那边翻页/搜索/筛选都不动这份。
 */
export const useSidebarStore = createSessionListStore(20);

/**
 * 历史会话页 `/sessions` 那份列表 —— **带页码、带筛选**。
 */
export const useSessionsStore = createSessionListStore(20);
