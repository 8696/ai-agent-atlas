import { useCallback, useEffect, useState } from 'react';
import { Button, Collapse, Empty, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchSessionLog, type SessionTurnLogResponse, type TurnLogTurn } from '../../lib/api';
import { formatDateTime } from '../../lib/time';

/**
 * 会话日志页 `/sessions/:id/log` —— **「这一轮到底发生了什么」**
 * （见 [12-e E7](../../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **一个会话一份日志** —— 从用户发起，到上下文装配、模型请求与响应、
 *    工具判定与执行、记忆与技能的变化，**每一都摊开给你看**。
 *
 * ⚠️ **原文全量** —— 系统提示词、模型请求体、工具出参都在里面
 *    （落库前已脱敏，见 `lib/security/mask.ts`）。
 */
export function SessionLogPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<SessionTurnLogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSessionLog(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '日志拉取失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const turns = data?.turns ?? [];
  const eventCount = turns.reduce((sum, turn) => sum + turn.events.length, 0);

  return (
    <div>
      <header className="atlas-sessions-head">
        <div className="atlas-log-head">
          <h1>会话日志</h1>
          <p>
            {data?.session.title ?? '会话'} · 完整链路：上下文装配 · 模型请求与响应 · 工具判定与执行
            · 记忆与技能
          </p>
        </div>
        <Space>
          <Tag color="green">
            {turns.length} 轮 · {eventCount} 个事件
          </Tag>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => {
              void navigate(`/chat?session=${id}`);
            }}
          >
            回到对话
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

      {turns.length === 0 && !loading ? (
        <section className="atlas-panel">
          <div className="atlas-empty">
            <Empty description="这个会话还没有日志记录" />
          </div>
        </section>
      ) : null}

      {turns.map((turn, index) => (
        <TurnSection key={turn.id} turn={turn} index={index} />
      ))}
    </div>
  );
}

/** 一轮 */
function TurnSection(props: { turn: TurnLogTurn; index: number }) {
  const { turn, index } = props;
  return (
    <section className="atlas-panel atlas-log-turn">
      <div className="atlas-log-turn-head">
        <strong>第 {index + 1} 轮</strong>
        <Tag
          color={turn.status === 'finished' ? 'green' : turn.status === 'failed' ? 'red' : 'blue'}
        >
          {statusLabel(turn.status)}
        </Tag>
        <span className="atlas-muted">
          {formatDateTime(turn.startedAt)} · {turn.model ?? '模型未知'} · {turn.events.length}{' '}
          个事件
        </span>
      </div>
      <Collapse
        ghost
        items={turn.events.map((event) => ({
          key: String(event.seq),
          label: (
            <span className="atlas-log-event">
              <Tag>{event.label}</Tag>
              {/* 📌 **标题与类型一样就别重复了** —— 一行里少一处重复 */}
              {event.title && event.title !== event.label ? <span>{event.title}</span> : null}
            </span>
          ),
          children: <pre className="atlas-log-payload">{renderPayload(event.payload)}</pre>,
        }))}
      />
    </section>
  );
}

/** 状态的中文名 */
function statusLabel(status: string): string {
  if (status === 'finished') return '已完成';
  if (status === 'failed') return '已中断';
  if (status === 'unknown') return '状态未知';
  return '进行中';
}

/** 把 payload 渲染成 JSON 文本 */
function renderPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '（没有内容）';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return '（内容无法序列化）';
  }
}
