import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
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

  // 📌 **出厂提示词要摆好** —— 临时项目根是空的，
  //    启动时会从兜底模板写回 `prompts/*.md`，
  //    那会触发「用了兜底提示词」的提示（**降级路径**），
  //    于是每个用例的 SSE 里都多一条 `data-notice`。
  //    正常安装有完整的出厂文件 —— 测试环境要跟正常安装一样。
  const repoRoot = join(import.meta.dirname, '../..');
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  try {
    for (const name of readdirSync(join(repoRoot, 'prompts'))) {
      if (name.endsWith('.md')) copyFileSync(join(repoRoot, 'prompts', name), join(dir, 'prompts', name));
    }
    copyFileSync(join(repoRoot, 'SOUL.md'), join(dir, 'SOUL.md'));
  } catch {
    // 搬不动就算了 —— 顶多让测试里多一条提示，不至于跑不起来
  }
  return dir;
}
