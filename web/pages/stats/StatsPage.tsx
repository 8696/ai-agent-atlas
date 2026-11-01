import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Progress, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { fetchUsageStats, type UsageStatsResponse, type SessionUsage } from '../../lib/api';
import { formatCost, formatCount, formatTokens, scopeLabel } from '../../lib/format';
import { formatRelative } from '../../lib/time';

/**
 * 用量统计页 `/stats` —— **「我的 token 都花在哪儿了」**
 * （见 [12-d D7](../../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **数据源是 `cost_logs`** —— 每轮对话记一条，
 *    这里的数跟 `/usage` 命令、`yarn cost:report` 是同一个口径。
 *
 * ⚠️ **「合计」含没有会话归属的用量** —— 记忆抽取与检索摘要是全局副作用，
 *    不挂在任何会话上 → 单独一行说明，别让人以为「会话加起来对不上」。
 */
export function StatsPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<UsageStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await fetchUsageStats());
    } catch (err) {
      setError(err instanceof Error ? err.message : '统计拉取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sessions = useMemo(() => {
    const rows = stats?.sessions ?? [];
    const q = keyword.trim();
    return q ? rows.filter((row) => row.title.includes(q)) : rows;
  }, [stats, keyword]);

  const columns: TableColumnsType<SessionUsage> = [
    {
      title: '会话',
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
      title: 'Token',
      dataIndex: 'totalTokens',
      key: 'totalTokens',
      width: 110,
      align: 'right',
      // 📌 **缩写 + 悬停给精确值** —— 一列里要能比大小，也要能对账
      render: (value: number) => (
        <Tooltip title={`${formatCount(value)} token`}>
          <span className="atlas-token">{formatTokens(value)}</span>
        </Tooltip>
      ),
    },
    {
      title: '输入',
      dataIndex: 'inputTokens',
      key: 'inputTokens',
      width: 90,
      align: 'right',
      render: (value: number) => <span className="atlas-muted">{formatTokens(value)}</span>,
    },
    {
      title: '输出',
      dataIndex: 'outputTokens',
      key: 'outputTokens',
      width: 90,
      align: 'right',
      render: (value: number) => <span className="atlas-muted">{formatTokens(value)}</span>,
    },
    {
      title: '占比',
      key: 'share',
      width: 160,
      render: (_value, record) => {
        const total = stats?.total.totalTokens ?? 0;
        const percent = total > 0 ? Math.round((record.totalTokens / total) * 1000) / 10 : 0;
        return (
          <Progress
            percent={percent}
            size="small"
            showInfo={false}
            strokeColor="var(--atlas-accent)"
          />
        );
      },
    },
    {
      title: '消息数',
      dataIndex: 'messageCount',
      key: 'messageCount',
      width: 80,
      align: 'right',
      render: (value: number) => <span className="atlas-muted">{value}</span>,
    },
    {
      title: '最后活跃',
      dataIndex: 'lastActiveAt',
      key: 'lastActiveAt',
      width: 130,
      render: (value: string | null) => <span className="atlas-muted">{formatRelative(value)}</span>,
    },
  ];

  const total = stats?.total;
  const month = stats?.month;

  return (
    <div>
      <header className="atlas-sessions-head">
        <div>
          <h1>用量统计</h1>
          <p>每一轮对话都记账；这里是全部会话的 token 用量与花费。</p>
        </div>
        <Space>
          <Tag color="green">{stats?.sessionCount ?? 0} 个会话</Tag>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>
      </header>

      {error ? (
        <Typography.Paragraph type="danger">
          {error}
          <Button size="small" onClick={() => void load()} style={{ marginLeft: 8 }}>
            重试
          </Button>
        </Typography.Paragraph>
      ) : null}

      <section className="atlas-stat-cards">
        <StatCard label="总 token" value={formatTokens(total?.totalTokens ?? 0)} hint={formatCount(total?.totalTokens ?? 0)} />
        <StatCard label="本月 token" value={formatTokens(month?.totalTokens ?? 0)} hint="按本地时区分桶" />
        <StatCard label="输入 token" value={formatTokens(total?.inputTokens ?? 0)} hint={`输出 ${formatTokens(total?.outputTokens ?? 0)}`} />
        <StatCard label="费用" value={formatCost(total?.costUsd ?? 0)} hint={unpricedHint(total?.unpricedModels ?? [])} />
      </section>

      <section className="atlas-panel">
        <Tabs
          defaultActiveKey="sessions"
          items={[
            {
              key: 'sessions',
              label: `按会话（${stats?.sessions.length ?? 0}）`,
              children: (
                <>
                  <div className="atlas-filters">
                    <Input
                      prefix={<SearchOutlined />}
                      placeholder="搜索会话标题"
                      allowClear
                      aria-label="搜索会话标题"
                      style={{ maxWidth: 280 }}
                      value={keyword}
                      onChange={(event) => setKeyword(event.target.value)}
                    />
                  </div>
                  <Table<SessionUsage>
                    rowKey="id"
                    size="middle"
                    loading={loading}
                    columns={columns}
                    dataSource={sessions}
                    pagination={{
                      pageSize: 20,
                      showSizeChanger: false,
                      showTotal: (count) => `共 ${count} 个会话`,
                    }}
                    locale={{
                      emptyText: (
                        <Empty description={keyword ? '没有匹配的会话' : '还没有用量记录'} />
                      ),
                    }}
                  />
                </>
              ),
            },
            {
              key: 'models',
              label: `按模型（${stats?.models.length ?? 0}）`,
              children: (
                <Table
                  rowKey="model"
                  size="middle"
                  loading={loading}
                  pagination={false}
                  dataSource={stats?.models ?? []}
                  columns={[
                    { title: '模型', dataIndex: 'model', key: 'model' },
                    {
                      title: 'Token',
                      dataIndex: 'totalTokens',
                      key: 'totalTokens',
                      width: 110,
                      align: 'right',
                      render: (value: number) => (
                        <Tooltip title={`${formatCount(value)} token`}>
                          <span className="atlas-token">{formatTokens(value)}</span>
                        </Tooltip>
                      ),
                    },
                    {
                      title: '输入',
                      dataIndex: 'inputTokens',
                      key: 'inputTokens',
                      width: 100,
                      align: 'right',
                      render: (value: number) => <span className="atlas-muted">{formatTokens(value)}</span>,
                    },
                    {
                      title: '输出',
                      dataIndex: 'outputTokens',
                      key: 'outputTokens',
                      width: 100,
                      align: 'right',
                      render: (value: number) => <span className="atlas-muted">{formatTokens(value)}</span>,
                    },
                    {
                      title: '调用次数',
                      dataIndex: 'entries',
                      key: 'entries',
                      width: 100,
                      align: 'right',
                    },
                    {
                      title: '费用',
                      dataIndex: 'costUsd',
                      key: 'costUsd',
                      width: 100,
                      align: 'right',
                      render: (value: number) => formatCost(value),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'scopes',
              label: `按用途（${stats?.scopes.length ?? 0}）`,
              children: (
                <Table
                  rowKey="scope"
                  size="middle"
                  loading={loading}
                  pagination={false}
                  dataSource={stats?.scopes ?? []}
                  columns={[
                    {
                      title: '用途',
                      dataIndex: 'scope',
                      key: 'scope',
                      render: (value: string) => scopeLabel(value),
                    },
                    {
                      title: 'Token',
                      dataIndex: 'totalTokens',
                      key: 'totalTokens',
                      width: 110,
                      align: 'right',
                      render: (value: number) => (
                        <Tooltip title={`${formatCount(value)} token`}>
                          <span className="atlas-token">{formatTokens(value)}</span>
                        </Tooltip>
                      ),
                    },
                    {
                      title: '输入',
                      dataIndex: 'inputTokens',
                      key: 'inputTokens',
                      width: 100,
                      align: 'right',
                      render: (value: number) => <span className="atlas-muted">{formatTokens(value)}</span>,
                    },
                    {
                      title: '输出',
                      dataIndex: 'outputTokens',
                      key: 'outputTokens',
                      width: 100,
                      align: 'right',
                      render: (value: number) => <span className="atlas-muted">{formatTokens(value)}</span>,
                    },
                    {
                      title: '调用次数',
                      dataIndex: 'entries',
                      key: 'entries',
                      width: 100,
                      align: 'right',
                    },
                    {
                      title: '费用',
                      dataIndex: 'costUsd',
                      key: 'costUsd',
                      width: 100,
                      align: 'right',
                      render: (value: number) => formatCost(value),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </section>

      {(stats?.unattributedTokens ?? 0) > 0 ? (
        <p className="atlas-stats-note">
          合计里有 {formatTokens(stats?.unattributedTokens ?? 0)} token
          <span className="atlas-muted">
            （{formatCount(stats?.unattributedTokens ?? 0)}）没有会话归属
          </span>
          —— 那是记忆抽取与检索摘要的花费，它们是全局副作用，不挂在某个会话上。
        </p>
      ) : null}
    </div>
  );
}

/** 一张统计卡 */
function StatCard(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="atlas-stat-card">
      <div className="atlas-stat-label">{props.label}</div>
      <div className="atlas-stat-value">{props.value}</div>
      {props.hint ? <div className="atlas-stat-hint">{props.hint}</div> : null}
    </div>
  );
}

/** ⚠️ **没配单价的模型要点名** —— 费用显示 0 是「不知道多少钱」，不是「没花钱」 */
function unpricedHint(models: string[]): string {
  if (models.length === 0) return '单价表里都有';
  // 📌 **点名 + 截断** —— 只说「2 个模型」不够，得让人知道是哪两个
  const names = models.slice(0, 3).join('、');
  const more = models.length > 3 ? ` 等 ${models.length} 个` : '';
  return `${names}${more} 没配单价`;
}
