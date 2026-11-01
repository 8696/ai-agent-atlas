import { config as loadDotenv } from 'dotenv';
import { envSchema, validateRelations, type Env } from './config/schema.js';
import { DIRS, FILES, PROJECT_ROOT, ensureDirs, resolvePath } from './config/paths.js';
import { ensureFiles } from './config/ensure.js';
import { isConfigSecretField, registerSecret } from './lib/security/mask.js';

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

// ⚠️ **把配置里的密钥登记进打码表** —— 正则只认常见形态
//    （本项目在用的智谱 key 是 `id.secret`，`sk-` 那条规则匹配不上），
//    登记精确值才守得住「日志 / 流水 / 审计里搜不到明文密钥」这条
//    （见 [12-e E4](./docs/12-e-需求-观测安全与验收.md)）。
for (const [key, value] of Object.entries(process.env)) {
  if (isConfigSecretField(key)) registerSecret(value);
}

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
 * import { paths } from './config.js';
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
  /**
   * 文件工具的沙箱根 —— **就是项目根**。
   *
   * ⚠️ **不再另设 `data/workspace`** —— 相对路径按项目根解析，
   *    `data/skills` 就是 `data/skills`，不会再被拼成 `data/workspace/data/skills`。
   *    项目外面的路径仍然拒绝。
   */
  workspaceRoot: PROJECT_ROOT,
  /** 实际生效的业务库路径（`DATABASE_PATH` 可配） */
  databaseFile: resolvePath(config.DATABASE_PATH),
} as const;

// ⚠️ 标准目录不存在就建 —— 首次启动 / 新机器拉代码后能直接跑
ensureDirs();

// ⚠️ 出厂文件 / 运行时文件不存在就补 —— 缺了也能直接跑
const { created, stripped } = ensureFiles();
if (created.length > 0) {
  console.info(
    `[Atlas] 已初始化 ${created.length} 个文件：\n` +
      created.map((p) => `  · ${p.replace(`${PROJECT_ROOT}/`, '')}`).join('\n'),
  );
}
// 📌 **旧出厂头注摘掉了** —— 记忆文件现在只装条目
if (stripped.length > 0) {
  console.info(
    `[Atlas] 已移除 ${stripped.length} 个记忆文件的旧出厂头注：\n` +
      stripped.map((p) => `  · ${p.replace(`${PROJECT_ROOT}/`, '')}`).join('\n'),
  );
}

export type { Env } from './config/schema.js';
export { PROJECT_ROOT, resolvePath } from './config/paths.js';
