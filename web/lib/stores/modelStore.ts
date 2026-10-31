import { create } from 'zustand';
import { fetchModels, type ModelInfo } from '../api';

/**
 * 模型信息 store —— **只管「当前用哪个模型 / 配没配」**。
 *
 * ⚠️ **模型配置不落前端缓存之外的任何地方** —— 前端**没有设置页**，
 * 模型改在 `.env`（见 [04-c](../docs/04-c-ui-配置入口.md)）。
 * 前端只读一次「配没配 / 叫什么」，用来显示顶栏与「还没配置模型」提示。
 */

interface ModelState {
  loading: boolean;
  /** 配没配模型 */
  configured: boolean;
  models: ModelInfo[];
  /** 拉取失败的原因（null = 没失败） */
  error: string | null;
  load: () => Promise<void>;
}

export const useModelStore = create<ModelState>()((set) => ({
  loading: false,
  configured: false,
  models: [],
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await fetchModels();
      set({ loading: false, configured: data.configured, models: data.models });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '连不上后端',
      });
    }
  },
}));
