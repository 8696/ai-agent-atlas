import { useEffect, useMemo, useRef, useState } from 'react';
import { Spin } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { ChatStatus, UIMessage } from 'ai';
import { Markdown } from '../../components/Markdown';

/**
 * 消息区（见 [04-b §4.1.1](../docs/04-b-ui-聊天页.md)）。
 *
 * | 元素   | 规格                                        |
 * | ------ | ------------------------------------------- |
 * | 用户气泡 | 右对齐，浅色底                              |
 * | AI 气泡 | 左对齐，**不拉满整行**（拉满 = 一大块空白） |
 * | 重新生成 | 在**最后一条 AI 消息**上，**必须传 messageId** |
 */

interface Props {
  messages: UIMessage[];
  status: ChatStatus;
  onRegenerate: (messageId: string) => void;
  /** 点建议问题 → 直接发出去 */
  onPickSuggestion?: (text: string) => void;
}

const SUGGESTIONS = [
  '用三句话介绍一下这个项目',
  '这个仓库的目录结构是怎么分的？',
  '我该怎么启动前后端？',
];

function partText(message: UIMessage, type: 'text' | 'reasoning'): string {
  return message.parts
    .filter((part) => part.type === type)
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function Caret() {
  return <span className="atlas-caret" aria-hidden />;
}

/** 思考 —— 进行中展开并跟着滚到底；结束后收起。点标题可再打开。 */
function ThinkingTrace({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open]);

  if (!text) return null;

  return (
    <div className="atlas-think">
      <button
        type="button"
        className="atlas-think-label"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={open ? 'atlas-think-mark is-open' : 'atlas-think-mark'} aria-hidden />
        {live ? '思考中' : '思考'}
      </button>
      {open ? (
        <div ref={scroller} className="atlas-think-text">
          {text}
          {live ? <Caret /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function MessageList({ messages, status, onRegenerate, onPickSuggestion }: Props) {
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'assistant') return message.id;
    }
    return null;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="atlas-welcome">
        <p className="atlas-kicker">Atlas</p>
        <h1>今天想做什么</h1>
        <p className="atlas-welcome-lead">
          直接说话就行。它会调用已配置的模型回答你；工具和会话记录还没接上。
        </p>
        <div className="atlas-suggests">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              className="atlas-suggest"
              onClick={() => onPickSuggestion?.(text)}
            >
              <span>{text}</span>
              <ArrowRightOutlined className="atlas-suggest-arrow" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="atlas-thread">
      {messages.map((message) => {
        const text = partText(message, 'text');
        const reasoning = partText(message, 'reasoning');
        const isUser = message.role === 'user';
        const streaming = status === 'streaming' && message.id === lastAssistantId;
        const reasoningLive = streaming && reasoning.length > 0 && text.length === 0;

        if (isUser) {
          return (
            <div key={message.id} className="atlas-row-user">
              <div className="atlas-bubble-user">{text}</div>
              <div className="atlas-avatar atlas-avatar-user" aria-hidden>
                M
              </div>
            </div>
          );
        }

        return (
          <article key={message.id} className="atlas-row-ai">
            <div className="atlas-avatar" aria-hidden>
              A
            </div>
            <div className="atlas-ai-body">
              <ThinkingTrace text={reasoning} live={reasoningLive} />
              {text ? (
                <div className="atlas-answer atlas-markdown">
                  <Markdown>{text}</Markdown>
                  {streaming ? <Caret /> : null}
                </div>
              ) : null}
              {streaming && !text ? <Spin size="small" /> : null}
              {!streaming && message.id === lastAssistantId ? (
                <button type="button" className="atlas-redo" onClick={() => onRegenerate(message.id)}>
                  重新生成
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}