import Router from '@koa/router';
import { usageStats } from '../services/usage-stats.js';

/**
 * 用量统计网关 —— `/api/v1/stats/usage`
 * （见 [12-d D7](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ⚠️ **无鉴权**（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）——
 * 本地单用户，不做身份过滤。
 *
 * 📌 **只读** —— 这个网关不改任何数据。
 */
export const statsRouter = new Router({ prefix: '/api/v1' });

/**
 * `GET /api/v1/stats/usage` —— **用量统计页的数据源**。
 *
 * 📌 **一次给全**（合计 · 本月 · 按会话 · 按模型 · 按用途）——
 * 页面不用串好几个请求，也就不会出现「卡片先亮、表格后到」的错位。
 */
statsRouter.get('/stats/usage', async (ctx) => {
  ctx.body = await usageStats();
});
