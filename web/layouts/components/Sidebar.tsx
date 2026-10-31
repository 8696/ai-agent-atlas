import { useState } from 'react';
import { Button, Layout, Menu } from 'antd';
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
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const selectedKey = location.pathname.startsWith('/sessions') ? 'sessions' : 'chat';

  return (
    <Layout.Sider
      className="atlas-sider"
      width={240}
      collapsedWidth={64}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      breakpoint="lg"
      trigger={null}
      onBreakpoint={(broken) => setCollapsed(broken)}
    >
      <div className="atlas-sider-inner">
        <div className={collapsed ? 'atlas-brand is-collapsed' : 'atlas-brand'}>
          <span className="atlas-mark" aria-hidden>
            A
          </span>
          {collapsed ? null : (
            <div>
              <div className="atlas-brand-name">Atlas</div>
              <div className="atlas-brand-sub">本地 Agent</div>
            </div>
          )}
        </div>

        <div className="atlas-sider-new">
          <Button
            type="primary"
            block
            icon={<PlusOutlined />}
            onClick={() => {
              void navigate('/chat');
            }}
            aria-label="新对话"
          >
            {collapsed ? null : '新对话'}
          </Button>
        </div>

        <Menu
          mode="inline"
          inlineCollapsed={collapsed}
          selectedKeys={[selectedKey]}
          onClick={({ key }) => {
            void navigate(key === 'sessions' ? '/sessions' : '/chat');
          }}
          style={{ borderInlineEnd: 'none', flex: 1, overflowY: 'auto', background: 'transparent' }}
          items={[
            { key: 'chat', icon: <MessageOutlined />, label: '聊天' },
            { key: 'sessions', icon: <HistoryOutlined />, label: '历史会话' },
          ]}
        />

        {/* ⚠️ **必须给手动展开按钮** —— 折叠了打不开 = 功能不可达 */}
        <div className="atlas-sider-foot">
          <Button
            type="text"
            size="small"
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed((value) => !value)}
          />
        </div>
      </div>
    </Layout.Sider>
  );
}
