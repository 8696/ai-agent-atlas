import { useMemo } from 'react';
import { Button, Empty, Space, Typography, theme } from 'antd';
import { RedoOutlined, RobotOutlined } from '@ant-design/icons';
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

export function MessageList({ messages, status, onRegenerate, onPickSuggestion }: Props) {
  const { token } = theme.useToken();

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'assistant') return message.id;
    }
    return null;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div style={{ padding: '48px 0' }}>
        <Empty
          image={<RobotOutlined style={{ fontSize: 48, opacity: 0.4 }} />}
          description={
            <Space orientation="vertical" size={4}>
              <Typography.Text strong>Atlas 在这儿</Typography.Text>
              <Typography.Text type="secondary">
                直接说话就行 —— 它会调用模型回答你。
              </Typography.Text>
            </Space>
          }
        >
          <Space wrap>
            {SUGGESTIONS.map((text) => (
              <Button key={text} size="small" onClick={() => onPickSuggestion?.(text)}>
                {text}
              </Button>
            ))}
          </Space>
        </Empty>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {messages.map((message) => {
        const text = message.parts
          .filter((part) => part.type === 'text')
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');
        const isUser = message.role === 'user';
        const streaming =
          status === 'streaming' && message.id === lastAssistantId;

        if (isUser) {
          return (
            <div
              key={message.id}
              style={{ display: 'flex', justifyContent: 'flex-end' }}
            >
              <div
                style={{
                  maxWidth: '80%',
                  padding: '10px 14px',
                  borderRadius: token.borderRadius,
                  background: token.colorPrimaryBg,
                  color: token.colorText,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {text}
              </div>
            </div>
          );
        }

        return (
          <div key={message.id} style={{ maxWidth: 760 }}>
            <div
              className="atlas-markdown"
              style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {text ? <Markdown>{text}</Markdown> : null}
              {streaming ? (
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 16,
                    marginLeft: 2,
                    verticalAlign: 'text-bottom',
                    background: token.colorPrimary,
                    animation: 'atlas-blink 1s steps(2, start) infinite',
                  }}
                />
              ) : null}
            </div>
            {!streaming && message.id === lastAssistantId ? (
              <Button
                size="small"
                type="text"
                icon={<RedoOutlined />}
                onClick={() => onRegenerate(message.id)}
              >
                重新生成
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
