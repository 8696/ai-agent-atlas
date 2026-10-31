import { useState } from 'react';
import { Button, Space, Tag } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ToolOutlined,
} from '@ant-design/icons';

/**
 * 工具卡片 —— **「调了哪个工具、传了什么、返回了什么、耗时多久」**
 * （见 [12-b B7](../docs/12-b-需求-对话与编排.md) 与 [04-b §4.1.1](../docs/04-b-ui-聊天页.md)）。
 *
 * ⚠️ **出参默认折叠 + 截断** —— 长输出不给全屏铺开。
 * ⚠️ **失败要显示错误原因** —— 不吞掉。
 */

/** 工具卡片的数据（**与后端 `ToolCard` 一一对应**） */
export interface ToolCardData {
  toolCallId: string;
  toolName: string;
  source: string;
  status: 'running' | 'success' | 'error' | 'rejected';
  input: unknown;
  output?: string;
  error?: string;
  durationMs?: number;
  requiresConfirmation: boolean;
}

/** 待确认卡片的数据 */
export interface PendingConfirmData {
  toolCallId: string;
  toolName: string;
  args: unknown;
  risk: string;
  fingerprint: string;
}

/** 状态 → 展示 */
function statusOf(card: ToolCardData): { label: string; tone: string; icon: React.ReactNode } {
  if (card.status === 'running') {
    return { label: '执行中', tone: 'atlas-tag-run', icon: <LoadingOutlined /> };
  }
  if (card.status === 'success') {
    return { label: '成功', tone: 'atlas-tag-ok', icon: <CheckCircleOutlined /> };
  }
  if (card.status === 'rejected') {
    return { label: '已拒绝', tone: 'atlas-tag-warn', icon: <CloseCircleOutlined /> };
  }
  return { label: '失败', tone: 'atlas-tag-err', icon: <CloseCircleOutlined /> };
}

/** 入参 / 出参 → 可读文本 */
function preview(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[无法显示]';
  }
}

/** 子代理卡片的入参（**名字 · 任务**） */
interface SubagentInput {
  name?: string;
  task?: string;
}

/** 这是不是子代理卡片（**见 [12-b B10](../docs/12-b-需求-对话与编排.md)）） */
function isSubagent(card: ToolCardData): boolean {
  return card.toolName === 'spawn_subagent';
}

/** 子代理的名字（**没写就用默认名**） */
function subagentName(card: ToolCallCardProps['card']): string {
  const input = card.input as SubagentInput | undefined;
  return input?.name?.trim() || '子代理';
}

/** 子代理的任务 */
function subagentTask(card: ToolCallCardProps['card']): string {
  const input = card.input as SubagentInput | undefined;
  return input?.task?.trim() ?? '';
}

interface ToolCallCardProps {
  card: ToolCardData;
}

/** 工具调用卡片 */
export function ToolCallCard({ card }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const status = statusOf(card);
  const input = preview(card.input);
  const output = card.output ?? '';
  const subagent = isSubagent(card);

  return (
    <div className="atlas-tool" data-status={card.status}>
      <button
        type="button"
        className="atlas-tool-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="atlas-tool-icon" aria-hidden>
          <ToolOutlined />
        </span>
        {/* 📌 **子代理卡片显示名字** —— 「spawn_subagent」对用户没意义 */}
        <span className="atlas-tool-name">
          {subagent ? `子代理 · ${subagentName(card)}` : card.toolName}
        </span>
        <span className={`atlas-tag ${status.tone}`}>
          {status.icon}
          {status.label}
        </span>
        {card.durationMs !== undefined ? (
          <span className="atlas-tool-time">{card.durationMs}ms</span>
        ) : null}
        {card.requiresConfirmation ? (
          <span className="atlas-tag atlas-tag-warn">已确认</span>
        ) : null}
      </button>

      {card.error ? <div className="atlas-tool-error">{card.error}</div> : null}

      {/* 📌 **子代理：任务与摘要直接摊开** —— 用户要看到「派了什么活、查出了什么」 */}
      {subagent ? (
        <div className="atlas-tool-detail">
          {subagentTask(card) ? (
            <div className="atlas-tool-block">
              <div className="atlas-tool-label">任务</div>
              <pre className="atlas-tool-pre">{subagentTask(card)}</pre>
            </div>
          ) : null}
          {output ? (
            <div className="atlas-tool-block">
              <div className="atlas-tool-label">摘要</div>
              <pre className="atlas-tool-pre">{output}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {open && !subagent ? (
        <div className="atlas-tool-detail">
          {input ? (
            <div className="atlas-tool-block">
              <div className="atlas-tool-label">入参</div>
              <pre className="atlas-tool-pre">{input}</pre>
            </div>
          ) : null}
          {output ? (
            <div className="atlas-tool-block">
              <div className="atlas-tool-label">出参</div>
              <pre className="atlas-tool-pre">{output}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface PendingConfirmCardProps {
  payload: PendingConfirmData;
  /** 点批准 / 取消（**由聊天页统一处理**） */
  onConfirm: (approved: boolean) => void;
  /** 处理中（**点了之后要禁用按钮**） */
  busy?: boolean;
  /**
   * 已经处理过了（**批准或取消之后**）。
   *
   * ⚠️ **同一次调用的确认卡片会留在历史里** —— 刷新后它还在，
   *    但那次工具已经跑完了（后面有一张工具卡片）→ 不该再能点。
   */
  resolved?: boolean;
}

/**
 * 待确认卡片 —— **危险操作闸门**（见 [12-b B5](../docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **参数要摊开给用户看** —— 用户批的是这一组参数，不是「大概意思」。
 */
export function PendingConfirmCard({
  payload,
  onConfirm,
  busy,
  resolved,
}: PendingConfirmCardProps) {
  const args = preview(payload.args);
  return (
    <div className={`atlas-confirm${resolved ? ' is-resolved' : ''}`}>
      <div className="atlas-confirm-head">
        <span className="atlas-confirm-title">要执行「{payload.toolName}」</span>
        <Tag color={resolved ? 'default' : 'warning'}>
          {resolved ? '已处理' : '需要确认'}
        </Tag>
      </div>
      <div className="atlas-confirm-risk">{payload.risk}</div>
      {args ? <pre className="atlas-tool-pre">{args}</pre> : null}
      {resolved ? null : (
        <Space className="atlas-confirm-actions">
          <Button
            type="primary"
            size="small"
            loading={busy}
            onClick={() => onConfirm(true)}
            icon={<CheckCircleOutlined />}
          >
            批准
          </Button>
          <Button size="small" disabled={busy} onClick={() => onConfirm(false)}>
            取消
          </Button>
        </Space>
      )}
    </div>
  );
}

/** 一行提示（**比如「已达到步数上限」**） */
export function NoticeLine({ text }: { text: string }) {
  return <div className="atlas-notice">{text}</div>;
}
