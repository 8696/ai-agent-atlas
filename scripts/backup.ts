import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../src/config.js';
import { initDatabase, sequelize } from '../src/db.js';
import { logger } from '../src/logger.js';
import { DIRS, FILES, resolvePath } from '../src/config/paths.js';

/**
 * 数据备份 —— `yarn backup`（见 [11 §11.3](../docs/11-部署运维与成本.md)）。
 *
 * ```bash
 * yarn backup            # → backups/atlas-<时间戳>.tar.gz
 * ```
 *
 * ⚠️ **业务库用 `VACUUM INTO` 做在线备份** —— WAL 模式下直接拷文件
 *    可能拿到不一致的快照（见 [11 §11.3](../docs/11-部署运维与成本.md)）。
 *
 * 📌 **备份要同时含业务库与记忆文件** —— 记忆的真源在 Markdown 文件里，
 *    **文件丢了就真丢了**（索引可以重建，文件不能）。
 */

/** 一个要打进包里的文件 */
interface ArchiveEntry {
  /** 包内的路径（`/` 分隔） */
  name: string;
  /** 内容 */
  content: Buffer;
}

/** 备份输出目录 */
const BACKUP_DIR = DIRS.backups;

/**
 * 极简 tar 写入器（**ustar 格式**）。
 *
 * ⚠️ **自己写是为了不加依赖** —— 一个 tar 库不值得。
 *    格式是固定的：512 字节头 + 内容按 512 对齐 + 结尾两个空块。
 */
function buildTar(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const name = Buffer.from(entry.name, 'utf8');
    // ⚠️ **文件名不能超 100 字节** —— 超了就用 prefix 字段拆开
    if (name.length > 100) {
      throw new Error(`备份里的路径太长（> 100 字节）：${entry.name}`);
    }
    name.copy(header, 0);

    // ⚠️ **数字字段是八进制 + 结尾 NUL**（不是二进制）
    const octal = (value: number, width: number): string =>
      `${value.toString(8).padStart(width - 1, '0')}\0`;
    header.write(octal(0o644, 8), 100, 'ascii'); // mode
    header.write(octal(0, 8), 108, 'ascii'); // uid
    header.write(octal(0, 8), 116, 'ascii'); // gid
    header.write(octal(entry.content.length, 12), 124, 'ascii'); // size
    header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii'); // mtime
    header.write('        ', 148, 'ascii'); // ⚠️ **校验和先占位（算的时候当空格）**
    header.write('0', 156, 'ascii'); // typeflag = 普通文件
    header.write('ustar\0', 257, 'ascii'); // magic
    header.write('00', 263, 'ascii'); // version

    // 📌 **校验和 = 头里所有字节之和（校验和字段本身算空格）**
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

    chunks.push(header, entry.content);

    // ⚠️ **内容按 512 对齐**
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }

  // 📌 **结尾两个空块** —— 没有它们，某些解包器会报错
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/** 递归收集目录里的文件（**包内路径保持 `data/` 开头的相对结构**） */
function collectDir(root: string, base: string, entries: ArchiveEntry[]): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectDir(full, base, entries);
    } else if (stat.isFile()) {
      entries.push({
        name: `${base}/${relative(base, full).split(sep).join('/')}`,
        content: readFileSync(full),
      });
    }
  }
}

/** 时间戳（**`20261101-003015`** —— 文件名里能直接看懂） */
function stamp(): string {
  const now = new Date();
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

async function main(): Promise<void> {
  await initDatabase();

  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  // ── 1. 业务库：在线备份（`VACUUM INTO`） ──
  const snapshot = join(BACKUP_DIR, `atlas-${stamp()}.db`);
  if (existsSync(snapshot)) {
    throw new Error(`备份文件已存在：${snapshot}`);
  }
  // ⚠️ **`VACUUM INTO` 的路径必须是字面量** —— 不能用占位符
  await sequelize.query(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);

  const entries: ArchiveEntry[] = [];
  try {
    entries.push({ name: 'data/atlas.db', content: readFileSync(snapshot) });

    // ── 2. 记忆文件（**真源，丢了就没了**） ──
    collectDir(DIRS.memory, 'data/memory', entries);

    // ── 3. 技能包与配置（建议备份） ──
    collectDir(DIRS.skills, 'data/skills', entries);
    for (const file of [FILES.cron, FILES.pricing, resolvePath(config.MCP_CONFIG_PATH)]) {
      if (existsSync(file)) {
        entries.push({
          name: `data/${file.split(sep).pop() as string}`,
          content: readFileSync(file),
        });
      }
    }
  } finally {
    // ⚠️ **中间快照用完就删** —— 别在 backups/ 里留一堆裸库
    try {
      if (existsSync(snapshot)) {
        execFileSync('rm', ['-f', snapshot]);
      }
    } catch {
      // 删不掉不是致命问题 —— 后面会把整个目录打包
    }
  }

  const archive = join(BACKUP_DIR, `atlas-${stamp()}.tar.gz`);
  writeFileSync(archive, gzipSync(buildTar(entries)));

  console.info(`✅ 备份完成：${archive}`);
  console.info(`   含 ${entries.length} 个文件：`);
  for (const entry of entries) {
    console.info(`   · ${entry.name}`);
  }
  console.info('\n恢复：解压到项目根目录，覆盖同名文件。');
  console.info('⚠️ 恢复后建议跑一次 `yarn migrate` 与 `yarn search <关键词>` 校验索引。');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, '备份失败');
    process.exit(1);
  });
}
