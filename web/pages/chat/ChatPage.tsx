import { useEffect, useMemo, useRef, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import { Alert, Button, Space, Spin, Typography, theme } from 'antd';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { toUserMessage } from '../../lib/apiError';
import { useModelStore } from '../../lib/stores/modelStore';

/**
 * 聊天页 `/chat` —— **主界面**（见 [04-b §4.1](../docs/04-b-ui-聊天页.md)）。
 *
 * 📌 **前端用 `@ai-sdk/react` 的 `useChat`**，
 * 后端把 LangChain 的流翻译成 **AI SDK UI Message Stream**（见 [03-b §B.6.2](../docs/03-b-技术栈-后端栈.md)）。
 *
 * ⚠️ **本期没有会话落库** —— 刷新页面消息就没了（会话管理见 [12-b B2](../docs/12-b-需求-对话与编排.md)）。
 */
export function ChatPage() {
  const { token } = theme.useToken();

  // ⚠️ **transport 只建一次** —— 每次渲染新建会让 useChat 重新发请求
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/v1/chat' }), []);

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat({ transport });

  const [thinking, setThinking] = useState(false);

  const configured = useModelStore((state) => state.configured);
  const loadingModels = useModelStore((state) => state.loading);
  const loadModels = useModelStore((state) => state.load);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // 新消息 / 流式增量 → 滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';
  const errorText = error ? toUserMessage(error) : '';

  /** 最后一条消息的 id —— 「重试」时按它重发（见 [04-b §4.1.2](../docs/04-b-ui-聊天页.md)） */
  const lastMessageId = useMemo(() => {
    const last = messages[messages.length - 1];
    return last?.id ?? null;
  }, [messages]);

  const submit = (text: string) => {
    clearError();
    void sendMessage({ text }, { body: { thinking } });
  };

  /**
   * 「重试」—— **按 messageId 重发，不要再发一条新的**。
   *
   * ⚠️ 用 `regenerate({ messageId })` 而不是 `sendMessage` ——
   * 后者会把同一条问题再塞一遍，聊天区出现两个一样的气泡。
   */
  const retry = () => {
    clearError();
    if (lastMessageId) {
      void regenerate({ messageId: lastMessageId });
      return;
    }
    void loadModels();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 56px - 48px)',
        minHeight: 320,
      }}
    >
      {!loadingModels && !configured ? (
        <Alert
          type="warning"
          showIcon
          title="还没配置模型"
          description={
            <Typography.Text>
              改 <code>.env</code> 的 <code>LLM_BASE_URL</code> / <code>LLM_API_KEY</code> /{' '}
              <code>LLM_MODEL</code>，重启后端后就能聊了。
            </Typography.Text>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {errorText ? (
        <Alert
          type="error"
          showIcon
          title="这一轮没跑通"
          description={errorText}
          action={
            <Space>
              <Button size="small" onClick={() => clearError()}>
                知道了
              </Button>
              <Button size="small" type="primary" onClick={retry}>
                重试
              </Button>
            </Space>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', paddingRight: 4, minHeight: 0 }}
      >
        {loadingModels && messages.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <MessageList
            messages={messages}
            status={status}
            onRegenerate={(messageId) => void regenerate({ messageId })}
            onPickSuggestion={submit}
          />
        )}
      </div>

      <Composer
        busy={busy}
        disabled={!configured}
        thinking={thinking}
        onThinkingChange={setThinking}
        onSubmit={submit}
        onStop={() => void stop()}
      />
    </div>
  );
}
