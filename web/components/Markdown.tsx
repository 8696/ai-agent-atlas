import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import { Button, Tooltip, theme } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';

/**
 * Markdown 渲染 —— 引用块 / 代码块高亮 / 复制按钮（见 [04-b §4.1.1](../docs/04-b-ui-聊天页.md)）。
 *
 * ⚠️ **不渲染原始 HTML** —— `react-markdown` 默认不解析 HTML，
 * 模型返回的内容里带 `<script>` 也只是文本。
 *
 * ⚠️ **必须挂 `remark-gfm`** —— `react-markdown` 默认只走 CommonMark，
 * 而 CommonMark **没有表格语法**（表格是 GFM 扩展）。
 * 不挂这个插件，模型输出的 `| 列 | 列 |` 会被当普通段落，
 * 用户看到的是一堆竖线而不是表格。
 * 挂了之后 GFM 全套都生效：表格 · 删除线 · 任务列表 · 自动链接。
 *
 * ⚠️ **高亮配色跟着主题走** —— 颜色写在 `styles/global.css` 的 CSS 变量里，
 * 切深色时不用重新加载 CSS。
 */

/**
 * react-markdown 的 `children` 是 `ReactNode` —— 可能是字符串、数组或元素。
 * ⚠️ **不能直接 `String(children)`** —— 元素会变成 `"[object Object]"`，
 *    数组会被逗号串起来，两种都会混进代码块里。递归只取纯文本。
 */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

function CodeBlock({ html, raw, language }: { html: string; raw: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const { token } = theme.useToken();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（无权限 / 非安全上下文）—— 不打扰用户
    }
  };

  return (
    <div
      style={{
        position: 'relative',
        margin: '8px 0',
        borderRadius: token.borderRadius,
        border: `1px solid ${token.colorBorderSecondary}`,
        overflow: 'hidden',
      }}
    >
      <div className="atlas-code-label">
        <span>{language}</span>
        <Tooltip title={copied ? '已复制' : '复制代码'}>
          <Button
            size="small"
            type="text"
            aria-label="复制代码"
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={() => {
              void copy();
            }}
          />
        </Tooltip>
      </div>
      <pre className="hljs" style={{ margin: 0, padding: 12, overflowX: 'auto' }}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // ⚠️ 代码块自己渲染 —— 不要再套一层 <pre>
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }) => {
          const raw = textOf(children).replace(/\n$/, '');
          const match = /language-([A-Za-z0-9+#-]+)/.exec(className ?? '');
          if (!match) {
            return <code className="atlas-inline-code">{children}</code>;
          }
          const language = match[1];
          const html = hljs.getLanguage(language)
            ? hljs.highlight(raw, { language }).value
            : hljs.highlightAuto(raw).value;
          return <CodeBlock html={html} raw={raw} language={language ?? 'text'} />;
        },
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        // ⚠️ **表格套一层可横向滚动的容器** —— 宽表格会撑破气泡
        //    （`table` 组件替换的就是 <table> 本身，别把标签丢了）
        table: ({ children }) => (
          <div className="atlas-markdown-table">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
