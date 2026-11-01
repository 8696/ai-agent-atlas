import { expect, test } from '@playwright/test';

/**
 * 对话主竖切的 e2e —— **真浏览器 · 真前端产物 · 真后端**。
 *
 * 📌 **用斜杠命令当「一轮对话」** ——
 * `/help` 是**零 LLM 调用**的（服务端直接解析，见 [12-b B9](../docs/12-b-需求-对话与编排.md)），
 * 但它走的是**和真聊天完全一样的链路**：
 * 前端 `useChat` → `POST /api/v1/chat` → SSE → 工具卡片/命令 part → 落库 → 刷新回填。
 * ⚠️ **不烧 token** —— 真聊天会真的调模型，e2e 一次跑几十次就是几十次调用。
 *
 * 覆盖：
 * - 📌 **发一轮，AI 气泡出得来**（竖切的第一段）
 * - 📌 **命令结果落库，刷新后还在**（竖切的第二段 —— 后端重启也不丢）
 * - 📌 **会话 id 进了 URL**（刷新能回到同一个会话）
 * - 📌 **侧栏能列出这个会话**（标题也跟着出来了）
 */

/** 建一个会话（走真实接口） */
async function createSession(request: import('@playwright/test').APIRequestContext) {
  const created = await request.post('/api/v1/sessions');
  expect(created.ok()).toBeTruthy();
  return (await created.json()) as { id: string; title?: string };
}

test.describe('对话主竖切', () => {
  test('📌 发一轮命令 → 气泡出得来 → 刷新后还在', async ({ page, request }) => {
    const session = await createSession(request);

    await page.goto(`/chat?session=${session.id}`);

    // 📌 **发一条命令** —— 零模型调用，但走完整条链路
    const composer = page.locator('.atlas-composer textarea');
    await composer.fill('/help');
    await composer.press('Enter');

    // 📌 **AI 气泡出得来**（正文里有命令清单）
    const answer = page.locator('.atlas-answer').last();
    await expect(answer).toContainText('/help', { timeout: 15_000 });

    // 📌 **命令标签** —— 这条是命令的结果，不是模型回答
    await expect(page.locator('.atlas-cmd-badge').last()).toContainText('/help');

    // 📌 **URL 里有会话 id** —— 刷新能回到同一个会话
    await expect(page).toHaveURL(new RegExp(`session=${session.id}`));

    // 📌 **刷新后消息还在**（落库 → 回填）
    await page.reload();
    await expect(page.locator('.atlas-answer').last()).toContainText('/help', {
      timeout: 15_000,
    });
  });

  test('📌 侧栏能列出刚聊过的会话', async ({ page, request }) => {
    const session = await createSession(request);
    await page.goto(`/chat?session=${session.id}`);
    await page.locator('.atlas-composer textarea').fill('/help');
    await page.locator('.atlas-composer textarea').press('Enter');
    await expect(page.locator('.atlas-answer').last()).toContainText('/help', {
      timeout: 15_000,
    });

    // 📌 **侧栏刷一次就该出现**（标题由第一条用户消息决定）
    await page.goto('/chat');
    await expect(page.locator('.atlas-sider-sessions')).toContainText(
      session.title ?? '新对话',
    );
  });
});
