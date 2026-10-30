import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ⚠️ vitest 5 把 pool / maxWorkers / fileParallelism 全挪到了顶层，
    //    写在 test: 里会被静默忽略（不报错、不生效）。
    // ⚠️ fileParallelism 关掉：集成测试共用 SQLite 文件时并发会互相干扰。
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
