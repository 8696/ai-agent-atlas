import { expect, test } from '@playwright/test';

/**
 * 应用外壳的 e2e —— **真浏览器 · 真前端产物 · 真后端接口**。
 *
 * 📌 **只测主路径**（不聊天）——
 * 聊天会真的调模型、真的烧 token；
 * 「模型会不会好好用工具」由集成测试与人工验收负责，
 * e2e 负责的是「端到端确实通了」。
 *
 * 覆盖（[12-a A1 / A2](./12-a-需求-应用外壳与上下文.md) 与
 * [12-b B2 / B9](./12-b-需求-对话与编排.md)）：
 * - 打开就是聊天页（**不需要登录**）
 * - 侧栏能列出会话
 * - 斜杠命令能补全
 * - 历史会话页能打开
 * - 未知路由显示 404 页（不是白屏）
 */

test.describe('应用外壳', () => {
  test('📌 打开就是聊天页，不需要登录', async ({ page }) => {
    await page.goto('/');
    // 📌 **根路径自动跳聊天页**
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('.atlas-brand-name')).toHaveText('Atlas');
    // 📌 **输入框在**（没配模型时是禁用的，但仍然在）
    await expect(page.locator('.atlas-composer textarea')).toBeVisible();
  });

  test('📌 侧栏能列出会话', async ({ page, request }) => {
    // 📌 **先造一个会话** —— 走真实接口
    const created = await request.post('/api/v1/sessions');
    expect(created.ok()).toBeTruthy();
    const session = (await created.json()) as { id: string; title?: string };

    await page.goto('/chat');
    await expect(page.locator('.atlas-sider-sessions')).toContainText(
      session.title ?? '新对话',
    );
  });

  test('📌 斜杠命令能补全', async ({ page }) => {
    await page.goto('/chat');
    await page.locator('.atlas-composer textarea').fill('/');
    // 📌 **候选列表弹出来**
    const list = page.locator('.atlas-cmd-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText('/help');
  });

  test('📌 历史会话页能打开', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('.atlas-page-frame')).toBeVisible();
    // 📌 **表格在**（antd 的表格）
    await expect(page.locator('.atlas-page-frame table').first()).toBeVisible();
  });

  test('📌 未知路由显示 404 页（不是白屏 / 英文堆栈）', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.locator('.atlas-page-frame')).toContainText('页面不存在');
    await expect(page.locator('.atlas-page-frame')).toContainText('回到聊天');
  });

  test('📌 顶栏显示当前模型', async ({ page, request }) => {
    const models = await request.get('/api/v1/models');
    expect(models.ok()).toBeTruthy();
    const body = (await models.json()) as { models?: Array<{ name?: string }> };
    const name = body.models?.[0]?.name;
    if (!name) return; // ⚠️ 没配模型就不验了
    await page.goto('/chat');
    await expect(page.locator('.atlas-topbar')).toContainText(name);
  });
});
