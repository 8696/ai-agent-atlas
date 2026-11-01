import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { ErrorPage } from './pages/ErrorPage';
import { ChatPage } from './pages/chat/ChatPage';
import { SessionsPage } from './pages/sessions/SessionsPage';
import { SessionLogPage } from './pages/sessions/SessionLogPage';
import { StatsPage } from './pages/stats/StatsPage';

/**
 * 路由表 —— **`/chat` · `/sessions` · `/sessions/:id/log` · `/stats`**
 * （见 [03-c §C.3](../docs/03-c-技术栈-前端栈.md)）。
 *
 * ⚠️ **没有 `/login`** —— 服务完全无鉴权，打开就能用（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 * ⚠️ **没有 `/settings/*` · `/traces`** —— 配置在文件里。
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
      { path: 'chat', element: <ChatPage />, errorElement: <ErrorPage /> },
      { path: 'sessions', element: <SessionsPage />, errorElement: <ErrorPage /> },
      {
        // 📌 **会话全链路日志**（见 [12-e E7](../docs/12-e-需求-观测安全与验收.md)）
        path: 'sessions/:id/log',
        element: <SessionLogPage />,
        errorElement: <ErrorPage />,
      },
      { path: 'stats', element: <StatsPage />, errorElement: <ErrorPage /> },
      { path: '*', element: <ErrorPage status={404} /> },
    ],
  },
]);
