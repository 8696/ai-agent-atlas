import { Button, Empty, Input } from 'antd';
import { HistoryOutlined, SearchOutlined, StarOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

/**
 * 历史会话页 `/sessions` —— **本期占位**。
 *
 * ⚠️ **会话管理还没实现**（见 [12-b B2](../docs/12-b-需求-对话与编排.md)）：
 * 会话落库、列表、搜索、收藏、删除都在那一条需求里。
 * 筛选条先占住位置，控件保持禁用，避免看起来能搜其实没有数据。
 */
export function SessionsPage() {
  const navigate = useNavigate();

  return (
    <div>
      <header className="atlas-sessions-head">
        <div>
          <h1>历史会话</h1>
          <p>对话暂时只留在当前聊天页，刷新就会清掉。会话落库之后，可以在这里按标题搜索、只看收藏。</p>
        </div>
      </header>

      <section className="atlas-panel">
        <div className="atlas-filters">
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索标题"
            disabled
            aria-label="搜索会话"
            style={{ maxWidth: 280 }}
          />
          <Button icon={<StarOutlined />} disabled>
            只看收藏
          </Button>
        </div>
        <div className="atlas-empty">
          <Empty
            image={<HistoryOutlined style={{ fontSize: 42, color: 'var(--atlas-muted)' }} />}
            description="还没有可筛选的会话"
          >
            <Button type="primary" onClick={() => navigate('/chat')}>
              去聊天
            </Button>
          </Empty>
        </div>
      </section>
    </div>
  );
}