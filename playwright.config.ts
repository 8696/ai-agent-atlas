import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // ⚠️ **e2e 只测主路径**（5~8 条），不要把所有需求都塞进来 ——
  //    细粒度断言属于 L1 / L2 的活。
  //    理由：e2e 是整个回路里最慢的一环，它的存在价值是「端到端确实通了」，
  //    不是「每个边界都测到了」。
  fullyParallel: true,

  // CI 上禁用 `test.only`（本地允许 —— 调试单个用例时很有用）
  forbidOnly: !!process.env.CI,
  // ⚠️ **重试只兜偶发失败，不许掩盖真 bug**：
  //    重试仍然失败的必须标记出来（见 03-a §A.13 的 flaky 约定）
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:5180',
    // 失败才留证据（成功时不留 trace / 截图，省磁盘也省时间）
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  webServer: [
    // ⚠️⚠️ **不要用 `yarn dev`** ——
    //    `yarn dev` 会同时起前后端 + 跑迁移 + 拉起 Vite HMR，
    //    冷启动 30~120 秒，而且 HMR 的文件监听在测试期间会抢 CPU。
    //    改用「预构建产物 + vite preview」：构建只做一次，preview 秒起。
    {
      command: 'yarn build:frontend && yarn preview --port 5180',
      url: 'http://localhost:5180',
      reuseExistingServer: !process.env.CI,
      // ⚠️ 120 秒 → 30 秒：起不来就快速失败，不要干等
      timeout: 30_000,
    },
    // 📌 **后端也要起** —— e2e 走的是真实接口（会话列表 / 模型列表）
    //    ⚠️ **不聊天** —— 用例只验 UI 主路径，不烧 token
    //    📌 **用 `yarn serve` 而不是 `tsx src/server.ts`** ——
    //    `yarn` 才会把 `node_modules/.bin` 放进 PATH（`&&` 之后的那段拿不到）
    {
      command: 'yarn migrate && yarn serve',
      url: 'http://127.0.0.1:3100/api/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
