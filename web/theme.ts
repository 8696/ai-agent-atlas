import { theme, type ThemeConfig } from 'antd';

/**
 * 主题 token —— **三层：品牌 / 浅色 / 深色**（见 [04-a §4.5](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * ⚠️ **背景色不能共用一份** —— 共用则切了暗色仍是白底。
 * 这里浅色 / 深色各给一份算法（`defaultAlgorithm` / `darkAlgorithm`），
 * 页面里一律用 `theme.useToken()` 取色，**不写死浅色**。
 *
 * 色值与 `styles/global.css` 里 `html[data-theme]` 的变量是同一套，
 * 改品牌色时两处一起改。
 */

/** 品牌色（唯一一处写死的地方）—— 松绿，浅色深色共用，按钮上的字仍是浅色 */
export const BRAND_COLOR = '#1f4f46';

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';

const sharedToken = {
  colorPrimary: BRAND_COLOR,
  colorInfo: BRAND_COLOR,
  borderRadius: 8,
  fontSize: 14,
  fontFamily,
} as const;

export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    ...sharedToken,
    colorBgLayout: '#efeae2',
    colorBgContainer: '#fbf8f3',
    colorBgElevated: '#fffdf9',
    colorBorder: '#ddd4c8',
    colorBorderSecondary: '#e4dcd0',
    colorText: '#1c1915',
    colorTextSecondary: '#6e665d',
    colorPrimaryBg: '#e6f0ec',
    colorPrimaryBgHover: '#d5e6e0',
  },
  components: {
    Layout: {
      siderBg: '#fbf8f3',
      headerBg: '#fbf8f3',
      bodyBg: '#efeae2',
      headerHeight: 56,
    },
    Menu: {
      itemBorderRadius: 8,
      itemMarginInline: 8,
      itemMarginBlock: 2,
      itemHeight: 36,
    },
    Button: {
      primaryShadow: 'none',
    },
  },
};

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...sharedToken,
    colorBgLayout: '#111614',
    colorBgContainer: '#1b211e',
    colorBgElevated: '#242c28',
    colorBorder: '#3a433e',
    colorBorderSecondary: '#2d3531',
    colorText: '#ece8e1',
    colorTextSecondary: '#a39b92',
    colorPrimaryBg: '#1d2c28',
    colorPrimaryBgHover: '#264038',
  },
  components: {
    Layout: {
      siderBg: '#1b211e',
      headerBg: '#1b211e',
      bodyBg: '#111614',
      headerHeight: 56,
    },
    Menu: {
      itemBorderRadius: 8,
      itemMarginInline: 8,
      itemMarginBlock: 2,
      itemHeight: 36,
    },
    Button: {
      primaryShadow: 'none',
    },
  },
};

/** 主题模式 */
export type ThemeMode = 'light' | 'dark';
