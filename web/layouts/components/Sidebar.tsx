import { useState } from 'react';
import { Button, Layout, Menu, theme } from 'antd';
import {
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * 侧栏 —— **本期只有一组**（历史会话），没有「设置」组、没有「观测」组
 * （见 [04-a §4.3](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * ⚠️ **窄屏（< 992px）自动折叠**，且保留手动展开（折叠了打不开 = 功能不可达）。
 */
export function Sidebar() {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const selectedKey = location.pathname.startsWith('/sessions') ? 'sessions' : 'chat';

  return (
    <Layout.Sider
      width={240}
      collapsedWidth={64}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      breakpoint="lg"
      onBreakpoint={(broken) => setCollapsed(broken)}
      style={{
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: 12 }}>
        <Button
          type="primary"
          block
          icon={<PlusOutlined />}
          onClick={() => navigate('/chat')}
          aria-label="新对话"
        >
          {collapsed ? null : '新对话'}
        </Button>
      </div>

      <Menu
        mode="inline"
        selectedKeys={[selectedKey]}
        onClick={({ key }) => navigate(key === 'sessions' ? '/sessions' : '/chat')}
        style={{ borderInlineEnd: 'none', flex: 1, overflowY: 'auto' }}
        items={[
          { key: 'chat', icon: <MessageOutlined />, label: '聊天' },
          { key: 'sessions', icon: <HistoryOutlined />, label: '历史会话' },
        ]}
      />

      {/* ⚠️ **必须给手动展开按钮** —— 折叠了打不开 = 功能不可达
          （antd 的 Sider 默认 `trigger={null}`，不自己加就没有展开入口） */}
      <div style={{ padding: 8, textAlign: 'center', borderTop: `1px solid ${token.colorBorderSecondary}` }}>
        <Button
          type="text"
          size="small"
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => setCollapsed((value) => !value)}
        />
      </div>
    </Layout.Sider>
  );
}
