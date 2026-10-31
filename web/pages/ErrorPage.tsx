import { Button, Result, Typography } from 'antd';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';

/**
 * 错误页 —— 403 / 404 / 500 各有专门文案，**不显示英文原始错误**（见 [04-a §4.2](../docs/04-a-ui-总则布局与菜单.md)）。
 *
 * ⚠️ React Router v7 自带的路由级错误边界比顶层 `<ErrorBoundary>` **更靠近路由组件** ——
 * 每条路由都挂了它（见 `routes.tsx`）。
 */

interface Props {
  /** 直接指定状态码（用于 `*` 路由的 404） */
  status?: number;
}

export function ErrorPage({ status }: Props) {
  const error = useRouteError();
  const navigate = useNavigate();

  let code = status ?? 500;
  let title = '页面出错了';
  let detail = '出了点意外，返回聊天页继续。';

  if (isRouteErrorResponse(error)) {
    code = error.status;
    if (code === 404) {
      title = '页面不存在';
      detail = '这个地址没有对应的页面。';
    } else if (code === 403) {
      title = '没有权限';
      detail = '本地服务不设权限，可能路径写错了。';
    } else {
      title = `出错了（${code}）`;
      detail = '出了点意外，返回聊天页继续。';
    }
  } else if (error instanceof Error && error.message) {
    detail = error.message;
  } else if (status === 404) {
    title = '页面不存在';
    detail = '这个地址没有对应的页面。';
  }

  return (
    <Result
      status={code === 404 ? '404' : code === 403 ? '403' : '500'}
      title={title}
      subTitle={<Typography.Text type="secondary">{detail}</Typography.Text>}
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
