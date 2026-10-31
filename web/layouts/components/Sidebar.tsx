import { useEffect, useRef, useState } from 'react';
import { Button, Input, Layout, Popconfirm, Tooltip } from 'antd';
import type { InputRef } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useSessionStore } from '../../lib/stores/sessionStore';
import { formatRelative } from '../../lib/time';

/**
 * 侧栏 —— **本期只有一组**（历史会话），没有「设置」组、没有「观测」组
 * （见 [04-a §4.3](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * ⚠️ **窄屏（< 992px）自动折叠**，且保留手动展开（折叠了打不开 = 功能不可达）。
 *
 * ⚠️ **列表的 loading 与聊天面板的 loading 是分开的** ——
 * 切「只看收藏」/ 改搜索词只重拉列表，
 * **不会掐断正在流式输出的那一轮**（见 [12-b B2](../docs/12-b-需求-对话与编排.md)）。
 */

/** 搜索防抖（毫秒） */
const SEARCH_DEBOUNCE_MS = 250;

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);

  const items = useSessionStore((state) => state.items);
  const loading = useSessionStore((state) => state.loading);
  const query = useSessionStore((state) => state.query);
  const favoriteOnly = useSessionStore((state) => state.favoriteOnly);
  const load = useSessionStore((state) => state.load);
  const setQuery = useSessionStore((state) => state.setQuery);
  const setFavoriteOnly = useSessionStore((state) => state.setFavoriteOnly);
  const toggleFavorite = useSessionStore((state) => state.toggleFavorite);
  const rename = useSessionStore((state) => state.rename);
  const remove = useSessionStore((state) => state.remove);

  const currentSessionId = location.pathname === '/chat' ? searchParams.get('session') : null;

  // ⚠️ **首次进侧栏拉一次列表** —— 聊天页发完消息也会刷新它
  useEffect(() => {
    void load();
  }, [load]);

  // ⚠️ **搜索防抖** —— 每敲一个字就打一次服务端太吵
  const [searchText, setSearchText] = useState(query);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (searchText !== query) setQuery(searchText);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [searchText, query, setQuery]);

  const goChat = (sessionId?: string) => {
    void navigate(sessionId ? `/chat?session=${sessionId}` : '/chat');
  };

  return (
    <Layout.Sider
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
            onClick={() => goChat()}
            aria-label="新对话"
          >
            {collapsed ? null : '新对话'}
          </Button>
        </div>

        {collapsed ? null : (
          <>
            <div className="atlas-sider-tools">
              <Input
                size="small"
                allowClear
                prefix={<SearchOutlined />}
                placeholder="搜索会话"
                aria-label="搜索会话"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
              <Button
                size="small"
                type={favoriteOnly ? 'primary' : 'default'}
                icon={favoriteOnly ? <StarFilled /> : <StarOutlined />}
                onClick={() => setFavoriteOnly(!favoriteOnly)}
                aria-pressed={favoriteOnly}
              >
                只看收藏
              </Button>
            </div>

            <div className="atlas-sider-section">
              <button
                type="button"
                className="atlas-sider-section-link"
                onClick={() => {
                  void navigate('/sessions');
                }}
              >
                历史会话
              </button>
            </div>
          </>
        )}

        <div className="atlas-sider-sessions">
          {collapsed ? null : loading && items.length === 0 ? (
            <p className="atlas-sider-hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="atlas-sider-hint">
              {query || favoriteOnly ? '没有匹配的会话' : '还没有会话，去聊一句吧'}
            </p>
          ) : (
            items.map((item) => (
              <SessionRow
                key={item.id}
                id={item.id}
                title={item.title}
                favorite={item.favorite}
                active={item.id === currentSessionId}
                time={formatRelative(item.lastActiveAt)}
                onOpen={() => goChat(item.id)}
                onToggleFavorite={() => void toggleFavorite(item.id)}
                onRemove={() => void remove(item.id)}
                onRename={(title) => rename(item.id, title)}
              />
            ))
          )}
        </div>

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

/** 会话行 —— **标题 + 相对时间；悬停显示「重命名 / 收藏 / 删除」** */
function SessionRow(props: {
  id: string;
  title: string;
  favorite: boolean;
  active: boolean;
  time: string;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onRemove: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.title);
  const inputRef = useRef<InputRef | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === props.title) return;
    void props.onRename(next);
  };

  if (editing) {
    return (
      <div className="atlas-session-row is-editing">
        <Input
          size="small"
          ref={inputRef}
          value={draft}
          aria-label="会话标题"
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={commit}
          onBlur={commit}
        />
      </div>
    );
  }

  return (
    <div className={props.active ? 'atlas-session-row is-active' : 'atlas-session-row'}>
      <button type="button" className="atlas-session-main" onClick={props.onOpen}>
        <span className="atlas-session-title">
          {props.favorite ? <StarFilled className="atlas-session-star" /> : null}
          {props.title}
        </span>
        {props.time ? <span className="atlas-session-time">{props.time}</span> : null}
      </button>
      <div className="atlas-session-actions">
        <Tooltip title="重命名">
          <Button
            type="text"
            size="small"
            aria-label="重命名会话"
            icon={<EditOutlined />}
            onClick={() => {
              setDraft(props.title);
              setEditing(true);
            }}
          />
        </Tooltip>
        <Tooltip title={props.favorite ? '取消收藏' : '收藏'}>
          <Button
            type="text"
            size="small"
            aria-label={props.favorite ? '取消收藏' : '收藏会话'}
            icon={props.favorite ? <StarFilled /> : <StarOutlined />}
            onClick={props.onToggleFavorite}
          />
        </Tooltip>
        <Popconfirm
          title="删除这个会话？"
          description="消息会一起删掉，撤不回来。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={props.onRemove}
        >
          <Button type="text" size="small" danger aria-label="删除会话" icon={<DeleteOutlined />} />
        </Popconfirm>
      </div>
    </div>
  );
}
