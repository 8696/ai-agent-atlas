import { useEffect, useState } from 'react';
import { Button, Empty, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../lib/stores/sessionStore';
import { formatDateTime, formatRelative } from '../../lib/time';
import type { SessionSummary } from '../../lib/api';

/**
 * 历史会话页 `/sessions` —— **列表 / 搜索 / 收藏 / 删除**（见 [04-b §4.3](../docs/04-b-ui-聊天页.md)）。
 *
 * ⚠️ **搜索与「只看收藏」都在服务端筛** —— 前端只发参数、收结果。
 * ⚠️ **「总数」显示的是筛选后的数量** —— 卡上写全库总数、筛选后不变是常见 bug。
 */
export function SessionsPage() {
  const navigate = useNavigate();

  const items = useSessionStore((state) => state.items);
  const total = useSessionStore((state) => state.total);
  const page = useSessionStore((state) => state.page);
  const pageSize = useSessionStore((state) => state.pageSize);
  const loading = useSessionStore((state) => state.loading);
  const error = useSessionStore((state) => state.error);
  const query = useSessionStore((state) => state.query);
  const favoriteOnly = useSessionStore((state) => state.favoriteOnly);
  const load = useSessionStore((state) => state.load);
  const setQuery = useSessionStore((state) => state.setQuery);
  const setFavoriteOnly = useSessionStore((state) => state.setFavoriteOnly);
  const setPage = useSessionStore((state) => state.setPage);
  const toggleFavorite = useSessionStore((state) => state.toggleFavorite);
  const rename = useSessionStore((state) => state.rename);
  const remove = useSessionStore((state) => state.remove);

  const [searchText, setSearchText] = useState(query);
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [renameText, setRenameText] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  // ⚠️ **搜索防抖** —— 每敲一个字就打一次服务端太吵
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchText !== query) setQuery(searchText);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [searchText, query, setQuery]);

  const openRename = (session: SessionSummary) => {
    setRenaming(session);
    setRenameText(session.title);
  };

  const commitRename = () => {
    if (!renaming) return;
    const next = renameText.trim();
    const target = renaming;
    setRenaming(null);
    if (!next || next === target.title) return;
    void rename(target.id, next);
  };

  const removeMany = async () => {
    const ids = [...selected];
    setSelected([]);
    for (const id of ids) {
      await remove(id);
    }
  };

  const columns: TableColumnsType<SessionSummary> = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record) => (
        <button
          type="button"
          className="atlas-link"
          onClick={() => {
            void navigate(`/chat?session=${record.id}`);
          }}
        >
          {title}
        </button>
      ),
    },
    {
      title: '消息数',
      dataIndex: 'messageCount',
      key: 'messageCount',
      width: 90,
      align: 'right',
    },
    {
      title: '最后活跃',
      dataIndex: 'lastActiveAt',
      key: 'lastActiveAt',
      width: 160,
      render: (value: string | null) => (
        <TooltipCell title={formatDateTime(value)} text={formatRelative(value)} />
      ),
    },
    {
      title: '收藏',
      dataIndex: 'favorite',
      key: 'favorite',
      width: 80,
      render: (favorite: boolean, record) => (
        <Button
          type="text"
          size="small"
          aria-label={favorite ? '取消收藏' : '收藏'}
          icon={favorite ? <StarFilled /> : <StarOutlined />}
          onClick={() => void toggleFavorite(record.id)}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_value, record) => (
        <Space size={4}>
          <Button
            type="text"
            size="small"
            aria-label="重命名"
            icon={<EditOutlined />}
            onClick={() => openRename(record)}
          />
          <Popconfirm
            title="删除这个会话？"
            description="消息会一起删掉，撤不回来。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(record.id)}
          >
            <Button type="text" size="small" danger aria-label="删除" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <header className="atlas-sessions-head">
        <div>
          <h1>历史会话</h1>
          <p>对话会落库；刷新页面、切到别的会话再回来都还在。</p>
        </div>
        <Tag color="green">{total} 个会话</Tag>
      </header>

      <section className="atlas-panel">
        <div className="atlas-filters">
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索标题"
            allowClear
            aria-label="搜索会话"
            style={{ maxWidth: 280 }}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <Button
            icon={favoriteOnly ? <StarFilled /> : <StarOutlined />}
            type={favoriteOnly ? 'primary' : 'default'}
            onClick={() => setFavoriteOnly(!favoriteOnly)}
            aria-pressed={favoriteOnly}
          >
            只看收藏
          </Button>
          {selected.length > 0 ? (
            <Popconfirm
              title={`删除选中的 ${selected.length} 个会话？`}
              description="消息会一起删掉，撤不回来。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void removeMany()}
            >
              <Button danger icon={<DeleteOutlined />}>
                删除选中（{selected.length}）
              </Button>
            </Popconfirm>
          ) : null}
        </div>

        {error ? (
          <Typography.Paragraph type="danger">
            {error}
            <Button size="small" onClick={() => void load()} style={{ marginLeft: 8 }}>
              重试
            </Button>
          </Typography.Paragraph>
        ) : null}

        <Table<SessionSummary>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: false,
            onChange: (next) => setPage(next),
            showTotal: (count) => `共 ${count} 个（筛选后）`,
          }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys.map(String)),
          }}
          locale={{
            emptyText: (
              <Empty
                image={<HistoryOutlined style={{ fontSize: 42, color: 'var(--atlas-muted)' }} />}
                description={query || favoriteOnly ? '没有匹配的会话' : '还没有会话'}
              >
                <Button
                  type="primary"
                  onClick={() => {
                    void navigate('/chat');
                  }}
                >
                  去聊天
                </Button>
              </Empty>
            ),
          }}
        />
      </section>

      <Modal
        open={renaming !== null}
        title="重命名会话"
        okText="保存"
        cancelText="取消"
        onOk={commitRename}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          value={renameText}
          autoFocus
          aria-label="会话标题"
          onChange={(event) => setRenameText(event.target.value)}
          onPressEnter={commitRename}
        />
      </Modal>
    </div>
  );
}

/** 相对时间 + 绝对时间（**悬停看准的**） */
function TooltipCell({ title, text }: { title: string; text: string }) {
  return (
    <span title={title} className="atlas-muted">
      {text}
    </span>
  );
}
