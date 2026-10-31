import { describe, expect, it } from 'vitest';
import { describeRouteError } from '../../web/pages/error-view';

/**
 * 错误页文案的单元测试（见 [12-a A2](../docs/12-a-需求-应用外壳与上下文.md)）。
 *
 * 覆盖：
 * - ⚠️ **渲染抛错 → 显示 500 页**，不透出英文原始错误
 * - 404 / 403 各有专门文案
 */

/** 造一个 React Router 的路由错误响应 */
function routeError(status: number): unknown {
  return { status, statusText: 'x', data: undefined, internal: true };
}

describe('错误页文案', () => {
  it('⚠️ 渲染抛错 → 500 页，且**不透出英文原始错误**', () => {
    const view = describeRouteError(new Error("Cannot read properties of undefined (reading 'x')"));
    expect(view.code).toBe(500);
    expect(view.title).toBe('页面出错了');
    // 📌 **英文报错不能出现在页面上**
    expect(view.detail).not.toContain('Cannot read');
    expect(view.detail).toBe('出了点意外，返回聊天页继续。');
  });

  it('路由 404 → 「页面不存在」', () => {
    const view = describeRouteError(routeError(404));
    expect(view.code).toBe(404);
    expect(view.title).toBe('页面不存在');
  });

  it('路由 403 → 「没有权限」', () => {
    const view = describeRouteError(routeError(403));
    expect(view.code).toBe(403);
    expect(view.title).toBe('没有权限');
  });

  it('其它状态码 → 「出错了（code）」', () => {
    const view = describeRouteError(routeError(502));
    expect(view.code).toBe(502);
    expect(view.title).toBe('出错了（502）');
  });

  it('直接指定 status（`*` 路由的 404）→ 同样有文案', () => {
    const view = describeRouteError(undefined, 404);
    expect(view.code).toBe(404);
    expect(view.title).toBe('页面不存在');
  });

  it('什么都不知道 → 默认 500', () => {
    const view = describeRouteError(undefined);
    expect(view.code).toBe(500);
    expect(view.title).toBe('页面出错了');
  });
});
