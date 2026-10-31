import { Layout } from 'antd';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';

/**
 * 主布局 —— 侧栏 + 顶栏 + 内容区（见 [04-a §4.2](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * 📌 **内容区最大宽度 1200px 居中**。聊天页自己占满剩余高度，消息列在内部收窄。
 */
export function AppLayout() {
  const location = useLocation();
  const chat = location.pathname === '/chat' || location.pathname === '/';

  return (
    <Layout className="atlas-shell">
      <Sidebar />
      <Layout className="atlas-main">
        <Topbar />
        <Layout.Content className={chat ? 'atlas-content atlas-content-chat' : 'atlas-content'}>
          <div className={chat ? 'atlas-chat-frame' : 'atlas-page-frame'}>
            <Outlet />
          </div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
