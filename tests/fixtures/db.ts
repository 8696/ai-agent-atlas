import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **每个集成测试文件一个独立的临时 SQLite 库**。
 *
 * ⚠️ **为什么不用「全局关并行」来隔离**：
 * 那是用全局开关解决局部问题 —— 隔离做好之后并行跑测试是白捡的性能
 * （见 `vitest.config.ts` 的 `fileParallelism`）。
 *
 * ⚠️ **必须在 import `src/db.js` 之前调用**：
 * `src/config/paths.ts` 在**模块加载时**就算好了 `PROJECT_ROOT`，
 * 之后再设 `ATLAS_HOME` 已经晚了（ESM 的 import 会先于模块体执行）。
 *
 * 📌 **用法**：
 * ```ts
 * useTempDatabase();                       // ← 先切走
 * const { initDatabase } = await import('../../src/db');
 * const { umzug } = await import('../../scripts/migrate');
 * await initDatabase();
 * await umzug.up();                        // 建表
 * ```
 */
export function useTempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-test-'));
  process.env.ATLAS_HOME = dir;
  return dir;
}
