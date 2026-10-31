import { theme, type ThemeConfig } from 'antd';

/**
 * 主题 token —— **三层：品牌 / 浅色 / 深色**（见 [04-a §4.5](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * ⚠️ **背景色不能共用一份** —— 共用则切了暗色仍是白底。
 * 这里浅色 / 深色各给一份算法（`defaultAlgorithm` / `darkAlgorithm`），
 * 页面里一律用 `theme.useToken()` 取色，**不写死浅色**。
 */

/** 品牌色（唯一一处写死的地方） */
export const BRAND_COLOR = '#1677ff';

const sharedToken = {
  colorPrimary: BRAND_COLOR,
  borderRadius: 8,
  fontSize: 14,
} as const;

export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: { ...sharedToken },
};

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: { ...sharedToken },
};

/** 主题模式 */
export type ThemeMode = 'light' | 'dark';
