import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Typography } from 'antd';

/**
 * 顶层错误兜底 —— 渲染炸了时给一句人话，**不显示堆栈**（见 [04-a §4.6](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * ⚠️ React Router v7 自带的路由级错误边界**更靠近路由组件** ——
 * 路由里出错走 `routes.tsx` 的 `errorElement`，这里只兜底更外层的事。
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // ⚠️ 只记到控制台 —— 不往接口发，也不打密钥
    console.error('[atlas] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ maxWidth: 720, margin: '64px auto', padding: '0 24px' }}>
        <Typography.Title level={3}>页面出错了</Typography.Title>
        <Alert
          type="error"
          showIcon
          title="渲染时抛了异常"
          description="出了点意外，回到聊天页继续。原始错误在浏览器控制台里。"
          style={{ marginBottom: 16 }}
        />
        <Button type="primary" onClick={() => this.setState({ error: null })}>
          重试
        </Button>
      </div>
    );
  }
}
