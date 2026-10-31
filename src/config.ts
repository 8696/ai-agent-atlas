import { config as loadDotenv } from 'dotenv';
import { envSchema, validateRelations, type Env } from './config/schema';
import {
  DIRS,
  FILES,
  PROJECT_ROOT,
  ensureDirs,
  resolvePath,
} from './config/paths';
import { ensureFiles } from './config/ensure';

/**
 * 运行时配置 —— 启动时加载 + 校验，失败直接退出。
 *
 * 📌 **契约在 `src/config/schema.ts`**（纯 schema，不读 `process.env`）——
 * 这样 `scripts/sync-env.ts` 能安全 import 它做 `.env` 契约校验。
 *
 * ⚠️ **`.env` 从项目根读，不是从 cwd**（见 `config/paths.ts`）——
 * 换个目录启动也要能读到同一份配置。
 *
 * ⚠️ 改完 key 记得跑 `yarn env:sync`（同步）/ `yarn env:check`（只校验）。
 */

// ⚠️ 必须在读任何配置**之前**加载，且路径来自项目根
loadDotenv({ path: FILES.env });

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`\n[Atlas] 环境变量校验失败：\n${detail}\n`);
    console.error(`参考 ${FILES.envExample}；改完再启动。\n`);
    process.exit(1);
  }
  const problems = validateRelations(parsed.data);
  if (problems.length > 0) {
    console.error(`\n[Atlas] 配置校验失败：\n${problems.map((p) => `  · ${p}`).join('\n')}\n`);
    console.error(`参考 ${FILES.envExample}；改完再启动。\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const config: Env = loadEnv();

/**
 * **运行期路径** —— 全部是绝对路径。
 *
 * ⚠️ **代码里一律用这里的路径，不要自己拼相对路径**：
 * ```ts
 * import { paths } from './config';
 * fs.readFileSync(join(paths.prompts, 'system.md'), 'utf8');
 * ```
 * 相对路径只在**文档与 `.env` 里**出现（那是给人看的），
 * 代码里一律经过 `resolvePath()` 解析。
 */
export const paths = {
  /** 项目根 —— 所有相对路径的基准 */
  projectRoot: PROJECT_ROOT,
  ...DIRS,
  ...FILES,
  /** 实际生效的沙箱根（`WORKSPACE_ROOT` 可配，可能指向项目外） */
  workspaceRoot: resolvePath(config.WORKSPACE_ROOT),
  /** 实际生效的业务库路径（`DATABASE_PATH` 可配） */
  databaseFile: resolvePath(config.DATABASE_PATH),
} as const;

// ⚠️ 标准目录不存在就建 —— 首次启动 / 新机器拉代码后能直接跑
ensureDirs();

// ⚠️ 出厂文件 / 运行时文件不存在就补 —— 缺了也能直接跑
const { created } = ensureFiles();
if (created.length > 0) {
  console.log(
    `[Atlas] 已初始化 ${created.length} 个文件：\n` +
      created.map((p) => `  · ${p.replace(`${PROJECT_ROOT}/`, '')}`).join('\n'),
  );
}

export type { Env } from './config/schema';
export { PROJECT_ROOT, resolvePath } from './config/paths';
