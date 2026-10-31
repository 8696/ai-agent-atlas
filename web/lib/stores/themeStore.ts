import { create } from 'zustand';
import type { ThemeMode } from '../../theme';

/**
 * 主题 store —— **只管深浅色**（见 [03-c §C.4](../docs/03-c-技术栈-前端栈.md)）。
 *
 * ⚠️ **不跟会话状态混在一个 store** —— 否则「切只看收藏」这种小操作会触发整页重渲染。
 *
 * 📌 持久化到 `localStorage`；**没存过时跟随系统** `prefers-color-scheme`。
 */

const STORAGE_KEY = 'atlas.theme';

function readStoredMode(): ThemeMode | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

/** 初始模式：localStorage → 系统偏好 → 浅色 */
export function initialThemeMode(): ThemeMode {
  const stored = readStoredMode();
  if (stored) return stored;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

/** 把模式写进 `<html data-theme>` —— 首屏不闪白底靠它（见 `index.html`） */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['theme'] = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 隐私模式下 localStorage 可能不可写 —— 不影响使用
  }
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  mode: initialThemeMode(),
  setMode: (mode) => {
    applyThemeMode(mode);
    set({ mode });
  },
  toggle: () => {
    const next: ThemeMode = get().mode === 'dark' ? 'light' : 'dark';
    get().setMode(next);
  },
}));
