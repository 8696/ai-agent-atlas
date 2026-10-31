import { isRouteErrorResponse } from 'react-router-dom';

/**
 * 错误页的文案 —— **纯函数**（见 [04-a §4.2](../docs/04-a-ui-公共组件.md)）。
 *
 * 📌 **单独一个文件** —— `ErrorPage.tsx` 带 JSX 与 antd，
 * 测不动；这里没有 JSX，能被单元测试直接调。
 */

/** 一段错误该显示什么 */
export interface ErrorView {
  /** 状态码 */
  code: number;
  /** 标题 */
  title: string;
  /** 说明（**中文，不透出原始错误**） */
  detail: string;
}

/**
 * 错误 → 一段中文文案。
 *
 * ⚠️ **不透出 `error.message`** —— 那多半是英文的 JS 报错
 * （「Cannot read properties of undefined…」），
 * 用户看到的是「白屏 / 英文堆栈」而不是错误页。
 * 原始错误去控制台看，**别摆到页面上**。
 */
export function describeRouteError(error: unknown, status?: number): ErrorView {
  if (isRouteErrorResponse(error)) {
    const code = error.status;
    if (code === 404) {
      return { code, title: '页面不存在', detail: '这个地址没有对应的页面。' };
    }
    if (code === 403) {
      return { code, title: '没有权限', detail: '本地服务不设权限，可能路径写错了。' };
    }
    return { code, title: `出错了（${code}）`, detail: '出了点意外，返回聊天页继续。' };
  }
  if (status === 404) {
    return { code: 404, title: '页面不存在', detail: '这个地址没有对应的页面。' };
  }
  if (status === 403) {
    return { code: 403, title: '没有权限', detail: '本地服务不设权限，可能路径写错了。' };
  }
  return { code: 500, title: '页面出错了', detail: '出了点意外，返回聊天页继续。' };
}
