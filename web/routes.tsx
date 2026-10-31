import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { ErrorPage } from './pages/ErrorPage';
import { ChatPage } from './pages/chat/ChatPage';
import { SessionsPage } from './pages/sessions/SessionsPage';

/**
 * 路由表 —— **本期只有 2 条路由**：`/chat` · `/sessions`（见 [03-c §C.3](../docs/03-c-技术栈-前端栈.md)）。
 *
 * ⚠️ **没有 `/login`** —— 服务完全无鉴权，打开就能用（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 * ⚠️ **没有 `/settings/*` · `/traces` · `/cost`** —— 配置在文件里，观测走命令行。
 *
 * ⚠️ **每条路由都挂 `errorElement`** —— React Router v7 自带的内部错误边界
 * 比顶层 `<ErrorBoundary>` **更靠近路由组件**，不挂的话用户看到的是默认英文页 + 堆栈。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: '*', element: <ErrorPage status={404} /> },
    ],
  },
]);
