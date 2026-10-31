import { useState } from 'react';
import { Button, Checkbox, Flex, Input, Space, Typography } from 'antd';
import { SendOutlined, StopOutlined } from '@ant-design/icons';

/**
 * 输入区（见 [04-b §4.1.2](../docs/04-b-ui-聊天页.md)）。
 *
 * | 元素   | 规格                                       |
 * | ------ | ------------------------------------------ |
 * | 输入框 | 多行，`Enter` 发送 · `Shift+Enter` 换行     |
 * | 发送   | 空内容时禁用；发送中变成「停止」            |
 * | 停止   | 调 `chat.stop()`；已输出的内容保留          |
 * | 思考模式 | 勾选框 → 请求体带 `thinking`              |
 */

interface Props {
  /** 后端没配模型 / 请求进行中 —— 决定按钮形态 */
  busy: boolean;
  /** 整体禁用（比如没配模型） */
  disabled?: boolean;
  thinking: boolean;
  onThinkingChange: (value: boolean) => void;
  onSubmit: (text: string) => void;
  onStop: () => void;
}

export function Composer({
  busy,
  disabled = false,
  thinking,
  onThinkingChange,
  onSubmit,
  onStop,
}: Props) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    onSubmit(text);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <Input.TextArea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPressEnter={(event) => {
          // ⚠️ **Shift+Enter 换行** —— 不拦截
          if (event.shiftKey) return;
          event.preventDefault();
          submit();
        }}
        placeholder={
          disabled ? '还没配置模型，先改 .env 的 LLM_MODEL' : '说点什么…（Enter 发送，Shift+Enter 换行）'
        }
        autoSize={{ minRows: 2, maxRows: 10 }}
        disabled={disabled}
        aria-label="输入消息"
      />
      <Flex justify="space-between" align="center" style={{ marginTop: 8 }}>
        <Checkbox
          checked={thinking}
          disabled={disabled}
          onChange={(event) => onThinkingChange(event.target.checked)}
        >
          <Typography.Text type="secondary">思考模式</Typography.Text>
        </Checkbox>

        <Space>
          {busy ? (
            <Button icon={<StopOutlined />} onClick={onStop}>
              停止
            </Button>
          ) : null}
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={disabled || value.trim().length === 0}
            onClick={submit}
          >
            发送
          </Button>
        </Space>
      </Flex>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 12, display: 'block', marginTop: 4 }}
      >
        无鉴权 · 仅本机可访问
      </Typography.Text>
    </div>
  );
}
