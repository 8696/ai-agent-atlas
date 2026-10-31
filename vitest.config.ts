import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ⚠️ vitest 5 把 pool / fileParallelism / maxWorkers 全挪到了顶层，
    //    写在 test: 里会被静默忽略（不报错、不生效）。
    //
    // ⚠️ **fileParallelism 从 false 改回 true** ——
    //    之前关掉并行是为了「集成测试共用 SQLite 文件会互相干扰」，
    //    那是用**全局关并行**解决**局部隔离问题**：
    //    正确做法是**每个测试文件用独立的 SQLite 临时文件**
    //    （见 tests/fixtures/db.ts），隔离做好之后并行是白捡的性能。
    fileParallelism: true,

    // ⚠️ **`agent` reporter 是 Vitest 5 专为 AI 编码代理加的**：
    //    成功的用例**一行都不打**，只有失败的才输出详情。
    //    实测：100 个通过用例 —— default reporter 打 100 行，
    //    agent reporter 打 0 行。
    //    ⚠️ **这不是小事**：几百行 stdout 会塞满 agent 的 context，
    //    后面每一轮对话都变慢 —— 这是「agent 跑测试很慢」的隐形大头。
    reporters: ['agent'],

    // ⚠️ inline projects 共享同一个 Vite server 与 transform cache
    //    （Vitest 5 的优化）—— 不要把它们拆成独立的配置文件，那会各起一个 Vite。
    projects: [
      {
        // ── L1 · 单元测试：反馈回路的主体，秒级 ──
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          // ⚠️ 超时收到 5 秒：挂死的用例立刻失败，不占着 30 秒空等
          testTimeout: 5_000,
          hookTimeout: 5_000,
          reporters: ['agent'],
          // 纯函数无状态 → 不需要为每个用例重建模块上下文（省一半时间）
          pool: 'threads',
          isolate: false,
        },
      },
      {
        // ── L2 · 集成测试：真 SQLite（每文件独立库）· 模型一律 mock ──
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15_000,
          hookTimeout: 15_000,
          reporters: ['agent'],
          // 用 forks 而不是 threads：集成测试会开真 SQLite 文件句柄与定时器，
          // 进程隔离更稳（threads 下偶发的句柄冲突是 flaky 的常见来源）
          pool: 'forks',
        },
      },
    ],
  },
});
