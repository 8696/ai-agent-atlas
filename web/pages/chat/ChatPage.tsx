import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Space, Spin, Typography } from 'antd';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { toUserMessage } from '../../lib/apiError';
import { useModelStore } from '../../lib/stores/modelStore';
import { useSessionStore } from '../../lib/stores/sessionStore';
import { createSession, confirmToolCall, fetchSession, toggleMessageFavorite } from '../../lib/api';
import type { StoredMessage } from '../../lib/api';

/**
 * 聊天页 `/chat` —— **主界面**（见 [04-b §4.1](../docs/04-b-ui-聊天页.md)）。
 *
 * 📌 **前端用 `@ai-sdk/react` 的 `useChat`**，
 * 后端把 LangChain 的流翻译成 **AI SDK UI Message Stream**（见 [03-b §B.6.2](../docs/03-b-技术栈-后端栈.md)）。
 *
 * 📌 **会话在 URL 里**：`/chat?session=<id>` ——
 * 刷新页面能从库里回填历史（见 [12-b B2](../docs/12-b-需求-对话与编排.md)）。
 */

/** 库里的一条消息 → 前端的 UI Message */
function toUiMessage(message: StoredMessage): UIMessage {
  return {
    id: message.id,
    role:
      message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
    // ⚠️ **落库的 part 直接回灌** —— 结构与推给前端时一致（见 [05-a §5.1](../docs/05-a-数据模型-sqlite.md)）
    parts: message.parts as UIMessage['parts'],
  };
}

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionId = searchParams.get('session');

  // ⚠️ **transport 只建一次** —— 每次渲染新建会让 useChat 重新发请求
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/v1/chat' }), []);

  const upsertSession = useSessionStore((state) => state.upsert);
  const loadSessions = useSessionStore((state) => state.load);

  const { messages, sendMessage, status, stop, error, regenerate, clearError, setMessages } =
    useChat({
      transport,
      // ⚠️ **一轮结束后刷一次侧栏列表** —— 标题与活跃时间都变了
      onFinish: () => {
        void loadSessions();
      },
    });

  const configured = useModelStore((state) => state.configured);
  const loadingModels = useModelStore((state) => state.loading);
  const loadModels = useModelStore((state) => state.load);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 会话不存在了（被删了 / 库换了） */
  const [sessionMissing, setSessionMissing] = useState(false);
  /** 消息级收藏（**message id → true**） */
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  /** 刚建好、还没回填的会话（**回填会把刚发的消息冲掉**） */
  const pendingSessionRef = useRef<string | null>(null);
  /** 已经自动发过的问题（**刷新不重复问**） */
  const autoSentRef = useRef<string | null>(null);
  /** 历史回填的 promise（**发消息前要等它** —— 否则会把上个会话的消息写进新会话） */
  const historyReadyRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // 新消息 / 流式增量 → 滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /**
   * 回填历史 —— **刷新页面后消息还在**。
   *
   * ⚠️ **刚建好的会话不回填**：那会把刚发出去的那条冲掉。
   */
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setFavorites({});
      setSessionMissing(false);
      historyReadyRef.current = Promise.resolve();
      return;
    }
    if (pendingSessionRef.current === sessionId) {
      pendingSessionRef.current = null;
      historyReadyRef.current = Promise.resolve();
      return;
    }
    let alive = true;
    historyReadyRef.current = (async () => {
      try {
        const data = await fetchSession(sessionId);
        if (!alive) return;
        setSessionMissing(false);
        setMessages(data.messages.map(toUiMessage));
        setFavorites(
          Object.fromEntries(
            data.messages
              .filter((message) => message.favorite)
              .map((message) => [message.id, true]),
          ),
        );
      } catch {
        if (!alive) return;
        setSessionMissing(true);
        setMessages([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, setMessages]);

  /**
   * 建一个会话（**第一次发消息前才建**）——
   * 拿到 id 后把 URL 换成 `?session=<id>`，刷新还能回到这个会话。
   */
  const ensureSession = useCallback(async (): Promise<string> => {
    const created = await createSession();
    upsertSession(created);
    pendingSessionRef.current = created.id;
    setSearchParams({ session: created.id }, { replace: true });
    return created.id;
  }, [setSearchParams, upsertSession]);

  const submit = useCallback(
    async (text: string) => {
      clearError();
      // ⚠️ **先等历史回填完** —— 刚切到另一个会话就发消息的话，
      //    这时 `messages` 还是上一个会话的，发出去会把上一个会话的消息
      //    写进新会话的库里
      await historyReadyRef.current;
      const target = sessionId ?? (await ensureSession());
      await sendMessage({ text }, { body: { sessionId: target } });
    },
    [clearError, ensureSession, sendMessage, sessionId],
  );

  // ⚠️ **submit 的最新引用** —— 自动发送的定时器要用它，不能吃闭包里的旧值
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  /**
   * `/chat?q=xxx` → **自动发一次**，然后把 URL 换成 `?session=<id>`（刷新不重复问）。
   *
   * ⚠️ **不能在 mount effect 里直接调 `sendMessage`**：
   * `useChat` 在 unmount 时会 `chat.stop()`，StrictMode 下 mount effect 跑完立刻 cleanup，
   * 正好把 abort controller 取消掉 → **消息永远发不出去而且不报错**。
   * → `setTimeout(0)` 延后一拍再发。
   */
  useEffect(() => {
    const question = searchParams.get('q');
    if (!question) return;
    const timer = setTimeout(() => {
      if (autoSentRef.current === question) return;
      autoSentRef.current = question;
      void submitRef.current(question);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [searchParams]);

  /**
   * 「重新生成」—— **按 messageId 重发，不要再发一条新的**。
   *
   * ⚠️ 用 `regenerate({ messageId })` 而不是 `sendMessage` ——
   * 后者会把同一条问题再塞一遍，聊天区出现两个一样的气泡。
   */
  const regenerateAnswer = (messageId: string) => {
    clearError();
    if (!sessionId) {
      void loadModels();
      return;
    }
    void regenerate({ messageId, body: { sessionId } });
  };

  /** 消息级收藏（📌） */
  const toggleFavorite = useCallback(
    async (messageId: string) => {
      const next = !favorites[messageId];
      setFavorites((prev) => ({ ...prev, [messageId]: next }));
      try {
        const updated = await toggleMessageFavorite(messageId, next);
        setFavorites((prev) => ({ ...prev, [messageId]: updated.favorite }));
      } catch {
        setFavorites((prev) => ({ ...prev, [messageId]: !next }));
      }
    },
    [favorites],
  );

  /** 人工确认（**批准 / 取消**） */
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const handleConfirm = useCallback(
    async (approved: boolean, _toolCallId: string, fingerprint: string) => {
      if (!sessionId || confirming) return;
      setConfirming(true);
      setConfirmError('');
      try {
        // 📌 **把入参指纹带回去** —— 后端核对「批准的是不是这一组参数」
        const result = await confirmToolCall(sessionId, approved, fingerprint);
        // ⚠️ **`resumed` = 原来的流还在跑** —— 它会接着往下流，这里不用管
        // ⚠️ **`completed` = 后端重启过** —— 剩下的已经跑完，把结果并回那条消息
        if (result.mode === 'completed' && result.parts) {
          setMessages((prev) =>
            prev.map((message) => {
              const hasPending = message.parts.some((part) => part.type === 'data-pending-confirm');
              if (!hasPending) return message;
              const kept = message.parts.filter((part) => part.type !== 'data-pending-confirm');
              return {
                ...message,
                parts: [...kept, ...(result.parts as UIMessage['parts'])],
              };
            }),
          );
        }
      } catch (err) {
        setConfirmError(err instanceof Error ? err.message : '确认失败，请重试');
      } finally {
        setConfirming(false);
      }
    },
    [confirming, sessionId, setMessages],
  );

  const busy = status === 'submitted' || status === 'streaming';
  const errorText = error ? toUserMessage(error) : '';

  /**
   * **斜杠命令的动作**（见 [12-b B9](../../docs/12-b-需求-对话与编排.md)）。
   *
   * 📌 **命令在服务端解析** —— 前端只负责执行它要求的动作：
   * 新建会话 → 切 URL · 重新生成 → 调 `regenerate` · 撤销 → 重拉历史。
   * ⚠️ **处理过的命令要记住** —— 否则每次渲染都会重复执行。
   */
  const handledCommands = useRef(new Set<string>());

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const part = last.parts.find((item) => item.type === 'data-command') as
      { type: string; id?: string | undefined; data?: unknown } | undefined;
    if (!part) return;

    const key = `${last.id}:${part.id ?? 'command'}`;
    if (handledCommands.current.has(key)) return;
    handledCommands.current.add(key);

    const payload = part.data as
      { command?: string; action?: string; data?: Record<string, unknown> } | undefined;
    const action = payload?.action;
    const extra = payload?.data ?? {};

    if (action === 'new-session') {
      const created = extra['sessionId'];
      if (typeof created !== 'string') return;
      void fetchSession(created)
        .then((data) => upsertSession(data.session))
        .catch(() => {
          // 拉不到就先切过去，列表会在下次 load 时补上
        });
      setSearchParams({ session: created }, { replace: true });
      return;
    }

    if (action === 'retry') {
      const messageId = extra['messageId'];
      if (typeof messageId !== 'string' || !sessionId) return;
      void regenerate({ messageId, body: { sessionId } });
      return;
    }

    if (action === 'undo') {
      if (!sessionId) return;
      void fetchSession(sessionId)
        .then((data) => {
          setMessages(data.messages.map(toUiMessage));
          setFavorites(
            Object.fromEntries(
              data.messages
                .filter((message) => message.favorite)
                .map((message) => [message.id, true]),
            ),
          );
        })
        .catch(() => {
          // 拉不到就维持现状
        });
    }
  }, [messages, sessionId, regenerate, setMessages, setSearchParams, upsertSession]);

  return (
    <div className="atlas-chat">
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

      {sessionMissing ? (
        <Alert
          type="info"
          showIcon
          title="这个会话已经不在了"
          description="可能已被删除。开一个新对话就能继续。"
          action={
            <Button size="small" onClick={() => setSearchParams({}, { replace: true })}>
              开新对话
            </Button>
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
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  const last = messages[messages.length - 1];
                  if (last?.role === 'assistant') regenerateAnswer(last.id);
                }}
              >
                重试
              </Button>
            </Space>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {confirmError ? (
        <Alert
          type="error"
          showIcon
          title="确认没送出去"
          description={confirmError}
          action={
            <Button size="small" onClick={() => setConfirmError('')}>
              知道了
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div ref={scrollRef} className="atlas-chat-scroll">
        {loadingModels && messages.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <MessageList
            messages={messages}
            status={status}
            favorites={favorites}
            onRegenerate={regenerateAnswer}
            onToggleFavorite={(messageId) => void toggleFavorite(messageId)}
            onPickSuggestion={(text) => void submit(text)}
            onConfirm={(approved, toolCallId, fingerprint) =>
              void handleConfirm(approved, toolCallId, fingerprint)
            }
            confirming={confirming}
          />
        )}
      </div>

      <Composer
        busy={busy}
        disabled={!configured}
        onSubmit={(text) => void submit(text)}
        onStop={() => void stop()}
      />
    </div>
  );
}
