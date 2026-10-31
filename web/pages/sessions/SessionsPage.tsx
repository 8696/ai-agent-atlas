import { Button, Empty, Typography } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';

/**
 * 历史会话页 `/sessions` —— **本期占位**。
 *
 * ⚠️ **会话管理还没实现**（见 [12-b B2](../docs/12-b-需求-对话与编排.md)）：
 * 会话落库、列表、搜索、收藏、删除都在那一条需求里。
 * 现在先占住路由与菜单位，别让人以为页面不存在。
 */
export function SessionsPage() {
  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={4}>历史会话</Typography.Title>
      <Empty
        image={<HistoryOutlined style={{ fontSize: 48, opacity: 0.4 }} />}
        description={
          <Typography.Text type="secondary">
            会话列表还没做 —— 对话暂时只存在于当前页面，刷新即丢。
          </Typography.Text>
        }
      >
        <Button type="primary" href="/chat">
          去聊天
        </Button>
      </Empty>
    </div>
  );
}
