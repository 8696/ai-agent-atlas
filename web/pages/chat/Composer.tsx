import { useState } from 'react';
import { Button, Input } from 'antd';
import { ArrowUpOutlined, StopOutlined } from '@ant-design/icons';

/**
 * 输入区（见 [04-b §4.1.2](../docs/04-b-ui-聊天页.md)）。
 *
 * | 元素   | 规格                                       |
 * | ------ | ------------------------------------------ |
 * | 输入框 | 多行，`Enter` 发送 · `Shift+Enter` 换行     |
 * | 发送   | 空内容时禁用；发送中变成「停止」            |
 * | 停止   | 调 `chat.stop()`；已输出的内容保留          |
 */

interface Props {
  /** 后端没配模型 / 请求进行中 —— 决定按钮形态 */
  busy: boolean;
  /** 整体禁用（比如没配模型） */
  disabled?: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}

export function Composer({ busy, disabled = false, onSubmit, onStop }: Props) {
  const [value, setValue] = useState('');
  const canSend = !disabled && value.trim().length > 0;

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    onSubmit(text);
  };

  return (
    <div className="atlas-composer">
      <Input.TextArea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPressEnter={(event) => {
          // ⚠️ **Shift+Enter 换行** —— 不拦截
          if (event.shiftKey) return;
          event.preventDefault();
          submit();
        }}
        placeholder={disabled ? '先在 .env 里配置 LLM_MODEL' : '说点什么…'}
        autoSize={{ minRows: 3, maxRows: 8 }}
        disabled={disabled}
        variant="borderless"
        aria-label="输入消息"
      />
      <div className="atlas-composer-actions">
        {busy ? (
          <Button
            type="text"
            size="small"
            icon={<StopOutlined />}
            onClick={onStop}
            aria-label="停止"
          />
        ) : (
          <Button
            type="text"
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={!canSend}
            onClick={submit}
            aria-label="发送"
          />
        )}
      </div>
    </div>
  );
}
