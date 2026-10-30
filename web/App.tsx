import { useEffect, useState } from 'react';
import { Alert, Card, Descriptions, Spin, Typography } from 'antd';

/**
 * 骨架阶段的占位首页。
 * ⚠️ 真正的聊天界面见 [04-b](../docs/04-b-ui-登录与聊天页.md)，
 *    需求见 [12-b](../docs/12-b-需求-对话与编排.md)。
 */
export function AtlasApp() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');

  useEffect(() => {
    fetch('/api/v1/health')
      .then((r) => (r.ok ? setHealth('ok') : setHealth('down')))
      .catch(() => setHealth('down'));
  }, []);

  return (
    <div style={{ maxWidth: 720, margin: '64px auto', padding: '0 24px' }}>
      <Typography.Title level={2}>Atlas</Typography.Title>
      <Typography.Paragraph type="secondary">
        跑在本地的通用型 AI Agent（LangGraph.js 编排）。当前处于**骨架阶段** ——
        后端已可启动，业务功能见 <code>docs/12-*.md</code> 的需求清单。
      </Typography.Paragraph>

      <Card size="small" style={{ marginTop: 24 }}>
        {health === 'checking' ? (
          <Spin size="small" />
        ) : health === 'ok' ? (
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="后端">
              <span style={{ color: '#52c41a' }}>已连接</span>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Alert
            type="error"
            showIcon
            message="后端未连接"
            description="确认后端已启动（yarn dev:backend），或检查 vite 的 /api 代理配置。"
          />
        )}
      </Card>
    </div>
  );
}
