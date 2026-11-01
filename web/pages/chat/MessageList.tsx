import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { ChatStatus, UIMessage } from 'ai';
import { Markdown } from '../../components/Markdown';
import {
  NoticeLine,
  PendingConfirmCard,
  ToolCallCard,
  type PendingConfirmData,
  type ToolCardData,
} from './ToolCallCard';

/**
 * 消息区（见 [04-b §4.1.1](../docs/04-b-ui-聊天页.md)）。
 *
 * | 元素   | 规格                                        |
 * | ------ | ------------------------------------------- |
 * | 用户气泡 | 右对齐，浅色底                              |
 * | AI 气泡 | 左对齐，**不拉满整行**（拉满 = 一大块空白） |
 * | 重新生成 | 在**最后一条 AI 消息**上，**必须传 messageId** |
 * | 工具卡片 | 在**正文上方**，按发生顺序排列（见 [12-b B7](../docs/12-b-需求-对话与编排.md)） |
 */

interface Props {
  messages: UIMessage[];
  status: ChatStatus;
  onRegenerate: (messageId: string) => void;
  /** 点建议问题 → 直接发出去 */
  onPickSuggestion?: (text: string) => void;
  /** 人工确认（**批准 / 取消**） */
  onConfirm?: (
    approved: boolean,
    toolCallId: string,
    fingerprint: string,
    approveAll?: boolean,
  ) => void;
  /** 确认处理中（**禁用按钮**） */
  confirming?: boolean;
}

const SUGGESTIONS = [
  '你现在能帮我做哪些事？',
  '把这个仓库的目录结构讲一遍',
  '记住：以后都用中文回复我',
];

function partText(message: UIMessage, type: 'text' | 'reasoning'): string {
  return message.parts
    .filter((part) => part.type === type)
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * 把一条消息的 part 拆成**按顺序的块**。
 *
 * ⚠️ **连续的文本 part 合成一块** —— 否则每段话都要包一次 Markdown。
 * ⚠️ **工具卡片 / 待确认卡片按出现顺序插在中间** —— 卡片要贴着它对应的上下文。
 */
type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; card: ToolCardData }
  | { kind: 'confirm'; payload: PendingConfirmData; resolved: boolean }
  | { kind: 'notice'; text: string };

function toBlocks(message: UIMessage): Block[] {
  const blocks: Block[] = [];
  let buffer = '';

  // ⚠️ **已经跑过的工具调用** —— 确认卡片对应的工具如果已经有结果卡片了，
  //    那次确认**已经处理过**，不该还能再点（刷新后仍能点会重复批准）
  const executedToolCalls = new Set(
    message.parts.flatMap((part) => {
      if (part.type !== 'data-tool-call') return [];
      const data = part.data as ToolCardData | undefined;
      return data?.toolCallId ? [data.toolCallId] : [];
    }),
  );

  const flush = () => {
    if (buffer !== '') {
      blocks.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  for (const part of message.parts) {
    if (part.type === 'text') {
      const text = 'text' in part && typeof part.text === 'string' ? part.text : '';
      buffer += text;
      continue;
    }
    if (part.type === 'data-tool-call') {
      flush();
      blocks.push({ kind: 'tool', card: part.data as ToolCardData });
      continue;
    }
    if (part.type === 'data-pending-confirm') {
      flush();
      const payload = part.data as PendingConfirmData;
      blocks.push({
        kind: 'confirm',
        payload,
        resolved: executedToolCalls.has(payload.toolCallId),
      });
      continue;
    }
    if (part.type === 'data-notice') {
      const data = part.data as { text?: string };
      const text = data?.text ?? '';
      // ⚠️ **预算告警不进对话** —— 以前会插在 AI 回复后面，现在不显示
      if (text.includes('告警线')) continue;
      flush();
      blocks.push({ kind: 'notice', text });
      continue;
    }
  }
  flush();
  return blocks;
}

/**
 * 这条消息是不是**斜杠命令的结果**。
 *
 * 📌 **命令结果带一个 `data-command` part** —— 正文照常渲染，
 * 只是上面多一个「命令」标签（见 [12-b B9](../docs/12-b-需求-对话与编排.md)）。
 */
function commandOf(message: UIMessage): { name: string; action?: string } | null {
  for (const part of message.parts) {
    if (part.type !== 'data-command') continue;
    const data = part.data as { command?: string; action?: string } | undefined;
    if (!data?.command) continue;
    return { name: data.command, ...(data.action ? { action: data.action } : {}) };
  }
  return null;
}

function Caret() {
  return <span className="atlas-caret" aria-hidden />;
}

/**
 * 「正在生成」的三个点 —— **等第一个字时的占位**。
 *
 * ⚠️ **没有它就像卡住了** —— AI 气泡先建出来、内容后到，
 *    中间那段空窗（模型首字延迟，通常好几秒）一点动静都没有。
 * 📌 **两段空窗都要盖住**：
 * ① 发出去 → 服务端把气泡建出来之前（网络往返）
 * ② 气泡建好 → 第一个字到之前（首字延迟）
 */
function TypingDots() {
  return (
    <span className="atlas-typing" role="status" aria-label="正在生成回复">
      <span className="atlas-typing-dot" />
      <span className="atlas-typing-dot" />
      <span className="atlas-typing-dot" />
    </span>
  );
}

/** 思考 —— 进行中展开并跟着滚到底；结束后收起。点标题可再打开。 */
function ThinkingTrace({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  const [wasLive, setWasLive] = useState(live);
  const scroller = useRef<HTMLDivElement>(null);

  // ⚠️ **气泡比思考内容先出现** —— 第一次渲染时还没有思考文本，
  //    `open` 会停在「关」。后面的增量到了必须跟着打开，
  //    否则整段思考要攒完、再点开才看得到。
  if (live !== wasLive) {
    setWasLive(live);
    setOpen(live);
  }

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

export function MessageList({
  messages,
  status,
  onRegenerate,
  onPickSuggestion,
  onConfirm,
  confirming,
}: Props) {
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'assistant') return message.id;
    }
    return null;
  }, [messages]);

  /**
   * 这一轮还在跑 —— **提交了（submitted）+ 在流（streaming）**。
   *
   * ⚠️ **别只看 `streaming`** —— AI SDK 在收到 `start` chunk 时
   * 是带着 `updateStatus: false` 写状态的，所以**从发出到第一个字到**
   * 这一整段状态都是 `submitted`（不等第一个字就没有 `streaming`）。
   * 只认 `streaming` 的话，**等首字的那几秒里什么都不显示**。
   */
  const busy = status === 'submitted' || status === 'streaming';

  const lastMessage = messages[messages.length - 1];

  /**
   * **AI 还没开口** —— 用户刚发完，AI 气泡都还没建出来。
   *
   * 📌 **这时要先占一个位** —— 不然界面只剩用户那句话，像没反应。
   */
  const awaitingReply = busy && lastMessage?.role === 'user';

  /**
   * **正在生成的那条消息** —— 必须是**最后一条**且是 assistant。
   *
   * ⚠️ **不能用「最后一条 AI 消息」当它** —— 气泡还没建出来的时候，
   * 那指的是**上一轮**已经答完的消息（光标会跑到旧答案尾巴上）。
   */
  const liveId = busy && lastMessage?.role === 'assistant' ? lastMessage.id : null;

  if (messages.length === 0) {
    return (
      <div className="atlas-welcome">
        <p className="atlas-kicker">Atlas</p>
        <h1>今天想做什么</h1>
        <p className="atlas-welcome-lead">
          直接说话就行。它会调用已配置的模型回答你，对话会自动存进历史会话；
          也能调工具干活（危险操作会先问你）。
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
        const streaming = message.id === liveId;
        const reasoningLive = streaming && reasoning.length > 0 && text.length === 0;
        const blocks = toBlocks(message);
        const command = commandOf(message);
        /** 这条消息**一个字都还没有** —— 等第一个字 */
        const empty = blocks.length === 0 && reasoning.length === 0;

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
              {command ? <div className="atlas-cmd-badge">命令 /{command.name}</div> : null}
              <ThinkingTrace text={reasoning} live={reasoningLive} />
              {blocks.map((block, index) => {
                if (block.kind === 'tool') {
                  return (
                    <ToolCallCard
                      key={`tool-${block.card.toolCallId}-${index}`}
                      card={block.card}
                    />
                  );
                }
                if (block.kind === 'confirm') {
                  return (
                    <PendingConfirmCard
                      key={`confirm-${block.payload.toolCallId}-${index}`}
                      payload={block.payload}
                      busy={confirming}
                      resolved={block.resolved}
                      onConfirm={(approved, fingerprint, approveAll) =>
                        onConfirm?.(approved, block.payload.toolCallId, fingerprint, approveAll)
                      }
                    />
                  );
                }
                if (block.kind === 'notice') {
                  return <NoticeLine key={`notice-${index}`} text={block.text} />;
                }
                const last = index === blocks.length - 1;
                return (
                  <div key={`text-${index}`} className="atlas-answer atlas-markdown">
                    <Markdown>{block.text}</Markdown>
                    {streaming && last ? <Caret /> : null}
                  </div>
                );
              })}
              {streaming && empty ? <TypingDots /> : null}
              {!streaming && message.id === lastAssistantId ? (
                <div className="atlas-ai-tools">
                  <button
                    type="button"
                    className="atlas-redo"
                    onClick={() => onRegenerate(message.id)}
                  >
                    重新生成
                  </button>
                </div>
              ) : null}
            </div>
          </article>
        );
      })}

      {/* 📌 **AI 还没开口时的占位** —— 气泡建出来之前，界面不能只剩用户那句话 */}
      {awaitingReply ? (
        <article className="atlas-row-ai">
          <div className="atlas-avatar" aria-hidden>
            A
          </div>
          <div className="atlas-ai-body">
            <TypingDots />
          </div>
        </article>
      ) : null}
    </div>
  );
}
