import { Layout } from 'antd';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';

/**
 * 主布局 —— 侧栏 + 顶栏 + 内容区（见 [04-a §4.2](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * 📌 **内容区最大宽度 1200px 居中**。
 */
export function AppLayout() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sidebar />
      <Layout>
        <Topbar />
        <Layout.Content style={{ padding: 24 }}>
          <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
            <Outlet />
          </div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
