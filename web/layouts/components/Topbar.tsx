import { useEffect, useState } from 'react';
import { Button, Popover, Space, Tooltip, Typography } from 'antd';
import { InfoCircleOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import { fetchHealth } from '../../lib/api';
import { useModelStore } from '../../lib/stores/modelStore';
import { useThemeStore } from '../../lib/stores/themeStore';

/**
 * 顶栏 —— 页面标题 · 连接状态 · 当前模型 · 主题切换 · 关于
 * （见 [04-a §4.4](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * ⚠️ **没有用户菜单** —— 本期无鉴权、没有账号（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 * ⚠️ **没有预算告警条** —— 预算改在 `.env` 里，超预算由后端拦截后在聊天区显示。
 */

const TITLES: Record<string, string> = {
  '/chat': '聊天',
  '/sessions': '历史会话',
};

export function Topbar() {
  const location = useLocation();
  const mode = useThemeStore((state) => state.mode);
  const toggleTheme = useThemeStore((state) => state.toggle);
  const models = useModelStore((state) => state.models);
  const configured = useModelStore((state) => state.configured);
  const loadModels = useModelStore((state) => state.load);

  /** null = 还没探到 */
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        await fetchHealth();
        if (alive) setOnline(true);
      } catch {
        if (alive) setOnline(false);
      }
    };
    void ping();
    const timer = setInterval(() => void ping(), 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const title = TITLES[location.pathname] ?? 'Atlas';
  const modelName = models.find((m) => m.role === 'primary')?.name;
  const statusText = online === null ? '连接中' : online ? '已连接' : '断线中';

  const about = (
    <div style={{ maxWidth: 260 }}>
      <Typography.Paragraph style={{ marginBottom: 8 }}>
        <strong>Atlas</strong> · 本地 AI Agent（v0.1.0）
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        后端 <code>http://localhost:3100</code> · 前端 <code>http://localhost:5180</code>
      </Typography.Paragraph>
      <Typography.Text type="warning">无鉴权 · 仅本机可访问</Typography.Text>
    </div>
  );

  return (
    <div className="atlas-topbar">
      <span className="atlas-topbar-title">{title}</span>

      <Space size={8}>
        <Tooltip title={online === false ? '连不上后端' : '后端在线'}>
          <span className="atlas-status">
            <span
              className={
                online === null
                  ? 'atlas-status-dot'
                  : online
                    ? 'atlas-status-dot is-on'
                    : 'atlas-status-dot is-off'
              }
              aria-hidden
            />
            {statusText}
          </span>
        </Tooltip>

        <Tooltip title={configured ? `当前模型：${modelName ?? '未知'}` : '还没配置模型'}>
          <span className={configured ? 'atlas-model-pill' : 'atlas-model-pill is-warn'}>
            {configured ? (modelName ?? '未命名模型') : '未配置模型'}
          </span>
        </Tooltip>

        <Tooltip title={mode === 'dark' ? '切到浅色' : '切到深色'}>
          <Button
            type="text"
            aria-label="切换主题"
            icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleTheme}
          />
        </Tooltip>

        <Popover content={about} title="关于">
          <Button type="text" aria-label="关于" icon={<InfoCircleOutlined />} />
        </Popover>
      </Space>
    </div>
  );
}
