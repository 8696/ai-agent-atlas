/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles/global.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { router } from './routes';
import { applyThemeMode, useThemeStore } from './lib/stores/themeStore';
import { darkTheme, lightTheme } from './theme';

// ⚠️ **首屏先把主题定住** —— 否则会先亮一下再切深色
applyThemeMode(useThemeStore.getState().mode);

function Root() {
  const mode = useThemeStore((state) => state.mode);

  return (
    <ConfigProvider locale={zhCN} theme={mode === 'dark' ? darkTheme : lightTheme}>
      <AntApp>
        <RouterProvider router={router} />
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
