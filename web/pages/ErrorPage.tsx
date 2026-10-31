import { Button, Result, Typography } from 'antd';
import { useNavigate, useRouteError } from 'react-router-dom';
import { describeRouteError } from './error-view';

/**
 * 错误页 —— 403 / 404 / 500 各有专门文案，**不显示英文原始错误**（见 [04-a §4.2](../docs/04-a-ui-公共组件.md)）。
 *
 * ⚠️ React Router v7 自带的路由级错误边界比顶层 `<ErrorBoundary>` **更靠近路由组件** ——
 * 每条路由都挂了它（见 `routes.tsx`）。
 *
 * 📌 **文案逻辑在 `error-view.ts`** —— 纯函数，能被单元测试直接调。
 */

interface Props {
  /** 直接指定状态码（用于 `*` 路由的 404） */
  status?: number;
}

export function ErrorPage({ status }: Props) {
  const error = useRouteError();
  const navigate = useNavigate();
  const view = describeRouteError(error, status);

  // 📌 **原始错误只进控制台** —— 不摆到页面上
  if (error) console.error('[Atlas] 页面出错了', error);

  return (
    <Result
      status={view.code === 404 ? '404' : view.code === 403 ? '403' : '500'}
      title={view.title}
      subTitle={<Typography.Text type="secondary">{view.detail}</Typography.Text>}
      extra={
        <Button
          type="primary"
          onClick={() => {
            void navigate('/chat');
          }}
        >
          回到聊天
        </Button>
      }
    />
  );
}
