/**
 * env 契约守卫 —— `.env` 与 `.env.example` 必须与 `src/config/schema.ts` 一致。
 *
 * 用法：
 * ```bash
 * yarn env:check   # 只校验，有问题退出码 1（提交前跑）
 * yarn env:sync    # 修能修的（补 key / 排顺序），问题项只报告
 * ```
 *
 * ⚠️ **能自动修的**：
 * - 文件里缺某个 key → 从另一个文件补（值取 `.env` 的，注释取 `.env.example` 的）
 * - 两个文件的 key 顺序不一致 → 按 schema 的顺序重排
 *
 * ⚠️ **只报告不自动改的**：
 * - **死 key**（文件里有、schema 里没有）→ 问「代码是真不要了，还是只是没走 config.ts？」
 * - **漏配**（schema 里有、文件里没有，但两个文件都没有）→ 补进 `.env.example`
 * - **`.env` 有、模板没有的 key** → 问「是死 key 该删，还是模板漏了这一节该补？」
 *
 * 见 [AGENTS.md §4.3](../AGENTS.md)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ENV_KEYS } from '../src/config/schema.js';
import { FILES } from '../src/config/paths.js';

const ENV_PATH = FILES.env;
const EXAMPLE_PATH = FILES.envExample;

const CHECK_ONLY = process.argv.includes('--check');

interface ParsedEnv {
  /** 出现顺序的 key */
  order: string[];
  /** key → 该 key 上方的注释块 + 自己的 `KEY=value` 行 */
  blocks: Map<string, string[]>;
  /** 不属于任何 key 的文件头注释 */
  head: string[];
}

function parseEnvFile(path: string): ParsedEnv {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const order: string[] = [];
  const blocks = new Map<string, string[]>();
  const head: string[] = [];

  let pending: string[] = [];
  let seenKey = false;

  for (const line of lines) {
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (!m) {
      // 注释 / 空行 / 分节标题 —— 归给「下一个 key」或文件头
      if (seenKey) pending.push(line);
      else head.push(line);
      continue;
    }
    const key = m[1];
    if (!key) continue;
    order.push(key);
    blocks.set(key, [...pending, line]);
    pending = [];
    seenKey = true;
  }
  return { order, blocks, head };
}

function render(parsed: ParsedEnv, keys: string[]): string {
  const out: string[] = [...parsed.head];
  for (const key of keys) {
    const block = parsed.blocks.get(key);
    if (block) out.push(...block);
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/, '') + '\n'
  );
}

/**
 * ⚠️ **供应商变量不在配置契约内** —— 它们由用户自带（换供应商不用改代码）：
 * `XXX_API_KEY` · `XXX_BASE_URL` · `XXX_MODEL`
 *
 * 所以它们**不算死 key**，也**不算漏配** ——
 * 契约只管「Atlas 自己的配置项」，不管「用户接了哪家供应商」。
 */
const VENDOR_VAR = /_(API_KEY|BASE_URL|MODEL)$/;

function isVendorVar(key: string): boolean {
  return VENDOR_VAR.test(key);
}

function main(): void {
  const env = parseEnvFile(ENV_PATH);
  const example = parseEnvFile(EXAMPLE_PATH);
  const schemaKeys: string[] = [...ENV_KEYS];

  const problems: string[] = [];
  const fixable: string[] = [];

  // ── 死 key：文件里有、schema 里没有、也不是供应商变量 ──
  for (const [label, parsed] of [
    ['.env', env],
    ['.env.example', example],
  ] as const) {
    const dead = parsed.order.filter((k) => !schemaKeys.includes(k) && !isVendorVar(k));
    if (dead.length > 0) {
      problems.push(`死 key —— ${label} 里有、envSchema 里没有：${dead.join(' · ')}`);
    }
    // ⚠️ **供应商变量的一致性**：`_API_KEY` 必须在两个文件里都出现
    //    （一个填真值、一个留空），否则换机器会漏
    const vendorVars = parsed.order.filter(isVendorVar);
    for (const v of vendorVars) {
      const inOther = label === '.env' ? example : env;
      if (!inOther.order.includes(v)) {
        problems.push(`供应商变量只在 ${label} 里有：${v} —— 两个文件应保持同一组 key（值可不同）`);
      }
    }
  }

  // ── 漏配：schema 有、两个文件都没有 ──
  const missingEverywhere = schemaKeys.filter(
    (k) => !env.order.includes(k) && !example.order.includes(k),
  );
  if (missingEverywhere.length > 0) {
    problems.push(`漏配 —— envSchema 里有、两个文件都没有：${missingEverywhere.join(' · ')}`);
  }

  // ── 漏配（可修）：schema 有、只有一个文件没有 ──
  const missingInEnv = schemaKeys.filter((k) => !env.order.includes(k));
  const missingInExample = schemaKeys.filter((k) => !example.order.includes(k));

  // ── 顺序不一致（可修）──
  // ⚠️ **只比较「契约 key」的相对顺序** —— 供应商变量不参与
  //    （它们的位置由用户在 .env 里自己安排，通常紧挨在「模型供应商」section）
  const contractOrder = (parsed: ParsedEnv): string[] =>
    parsed.order.filter((k) => schemaKeys.includes(k));
  const orderMismatch =
    JSON.stringify(contractOrder(env)) !== JSON.stringify(schemaKeys) ||
    JSON.stringify(contractOrder(example)) !== JSON.stringify(schemaKeys);

  if (problems.length > 0) {
    console.error('\n[env] 以下问题需要人工判断，不自动修：');
    for (const p of problems) console.error(`  · ${p}`);
    console.error('');
  }

  if (missingInEnv.length > 0) fixable.push(`.env 缺 ${missingInEnv.join(' · ')}`);
  if (missingInExample.length > 0) fixable.push(`.env.example 缺 ${missingInExample.join(' · ')}`);
  if (orderMismatch) fixable.push('key 顺序与 envSchema 不一致');

  if (CHECK_ONLY) {
    if (fixable.length > 0) {
      console.error('[env] 可自动修的问题（跑 `yarn env:sync` 修）：');
      for (const f of fixable) console.error(`  · ${f}`);
      console.error('');
    }
    if (problems.length > 0 || fixable.length > 0) {
      console.error('[env] 校验未通过。\n');
      process.exit(1);
    }
    console.info('[env] ✅ `.env` / `.env.example` / envSchema 三方一致\n');
    return;
  }

  // ── sync：修能修的 ──
  let changed = false;

  // 1) 补 key（值取 .env 的；都没有就取模板的）
  for (const key of missingInEnv) {
    const fromExample = example.blocks.get(key);
    if (fromExample) {
      env.blocks.set(key, fromExample);
      env.order.push(key);
      changed = true;
    }
  }
  for (const key of missingInExample) {
    const fromEnv = env.blocks.get(key);
    if (fromEnv) {
      example.blocks.set(key, fromEnv);
      example.order.push(key);
      changed = true;
    }
  }

  // 2) 按 schema 顺序重排
  /**
   * 重排：**只把契约 key 按 schema 顺序填回它们原来的槽位**，
   * 供应商变量保持原位与原相对顺序（别把「模型供应商」section 拆散）。
   */
  const sortBy = (parsed: ParsedEnv): string[] => {
    const contract = parsed.order.filter((k) => schemaKeys.includes(k));
    const vendor = parsed.order.filter((k) => !schemaKeys.includes(k));
    const sortedContract = schemaKeys.filter((k) => parsed.blocks.has(k));
    const out: string[] = [];
    let ci = 0;
    let vi = 0;
    for (const k of parsed.order) {
      if (schemaKeys.includes(k)) out.push(sortedContract[ci++] ?? k);
      else out.push(vendor[vi++] ?? k);
    }
    void contract;
    return out;
  };
  const newEnvOrder = sortBy(env);
  const newExampleOrder = sortBy(example);
  if (JSON.stringify(newEnvOrder) !== JSON.stringify(env.order)) changed = true;
  if (JSON.stringify(newExampleOrder) !== JSON.stringify(example.order)) changed = true;
  env.order = newEnvOrder;
  example.order = newExampleOrder;

  if (changed) {
    writeFileSync(ENV_PATH, render(env, env.order), 'utf8');
    writeFileSync(EXAMPLE_PATH, render(example, example.order), 'utf8');
    console.info('[env] 已同步：补 key + 按 envSchema 顺序重排');
  } else {
    console.info('[env] 无需修改');
  }

  if (problems.length > 0) {
    console.error('[env] ⚠️ 仍有需要人工判断的问题（见上）\n');
    process.exit(1);
  }
}

main();
