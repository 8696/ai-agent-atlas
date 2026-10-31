import { logger } from '../src/logger.js';
import {
  addMemory,
  archiveMemory,
  clearMemory,
  deleteMemory,
  editMemory,
  listMemories,
  readMemory,
} from '../src/services/memory/index.js';
import type { MemoryFile, MemoryKind } from '../src/services/memory/types.js';

/**
 * 长期记忆的命令行 —— `yarn memory:*`
 * （见 [12-d D2](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ```bash
 * yarn memory:list                 # 列出全部条目
 * yarn memory:list USER            # 只看 USER.md
 * yarn memory:add USER prefers-pnpm "用户用 pnpm，不用 npm"
 * yarn memory:edit USER prefers-pnpm "用户用 pnpm 装依赖"
 * yarn memory:archive USER prefers-pnpm
 * yarn memory:delete USER prefers-pnpm
 * yarn memory:clear USER
 * ```
 *
 * 📌 **与 Agent 自动维护的是同一套接口** —— 人改的与模型抽的走同一条路。
 */

/** 用法 */
const USAGE = `用法：
  yarn memory:list [MEMORY|USER]
  yarn memory:add <MEMORY|USER> <名字> <正文…> [--kind <kind>]
  yarn memory:edit <MEMORY|USER> <名字> <正文…>
  yarn memory:archive <MEMORY|USER> <名字>
  yarn memory:delete <MEMORY|USER> <名字>
  yarn memory:clear <MEMORY|USER>

kind 取值：fact · context · preference · profile`;

/** 把参数里的 `--kind xxx` 摘出来 */
function splitArgs(argv: string[]): { positional: string[]; kind?: string } {
  const positional: string[] = [];
  let kind: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--kind' && argv[i + 1]) {
      kind = argv[i + 1];
      i += 1;
      continue;
    }
    positional.push(argv[i] as string);
  }
  return { positional, ...(kind ? { kind } : {}) };
}

/** 校验文件名 */
function toFile(value: string | undefined): MemoryFile | null {
  const upper = (value ?? '').toUpperCase();
  return upper === 'MEMORY' || upper === 'USER' ? upper : null;
}

/** 打印全部条目 */
function printList(file?: MemoryFile): void {
  for (const target of file ? [file] : (['MEMORY', 'USER'] as MemoryFile[])) {
    const content = readMemory(target);
    const percent = Math.round((content.usedChars / Math.max(1, content.limit)) * 100);
    console.info(
      `\n${target}.md（${content.usedChars} / ${content.limit} 字符，${percent}%）` +
        (content.overLimit ? ' ⚠️ 已超上限' : ''),
    );
    if (content.entries.length === 0) {
      console.info('  （空）');
      continue;
    }
    for (const entry of content.entries) {
      const flags = [
        entry.kind,
        `置信度 ${entry.confidence}`,
        entry.source === 'manual' ? '手动' : '自动',
        entry.updated || '—',
        entry.status === 'archived' ? '已归档' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      console.info(`  ## ${entry.name}（${flags}）`);
      console.info(`     ${entry.body}`);
    }
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, kind } = splitArgs(rest);

  switch (command) {
    case 'list': {
      printList(toFile(positional[0]) ?? undefined);
      return;
    }

    case 'add': {
      const file = toFile(positional[0]);
      const name = positional[1];
      const body = positional.slice(2).join(' ');
      if (!file || !name || !body) {
        console.error(USAGE);
        process.exit(1);
      }
      const result = addMemory({
        file,
        name,
        body,
        ...(kind ? { kind: kind as MemoryKind } : {}),
      });
      console.info(result.ok ? result.message : `❌ ${result.message}`);
      if (!result.ok) process.exit(1);
      return;
    }

    case 'edit': {
      const file = toFile(positional[0]);
      const name = positional[1];
      const body = positional.slice(2).join(' ');
      if (!file || !name || !body) {
        console.error(USAGE);
        process.exit(1);
      }
      const result = editMemory({ file, name, body });
      console.info(result.ok ? result.message : `❌ ${result.message}`);
      if (!result.ok) process.exit(1);
      return;
    }

    case 'archive': {
      const file = toFile(positional[0]);
      const name = positional[1];
      if (!file || !name) {
        console.error(USAGE);
        process.exit(1);
      }
      const result = archiveMemory(file, name);
      console.info(result.ok ? result.message : `❌ ${result.message}`);
      if (!result.ok) process.exit(1);
      return;
    }

    case 'delete': {
      const file = toFile(positional[0]);
      const name = positional[1];
      if (!file || !name) {
        console.error(USAGE);
        process.exit(1);
      }
      const result = deleteMemory(file, name);
      console.info(result.ok ? result.message : `❌ ${result.message}`);
      if (!result.ok) process.exit(1);
      return;
    }

    case 'clear': {
      const file = toFile(positional[0]);
      if (!file) {
        console.error(USAGE);
        process.exit(1);
      }
      const result = clearMemory(file);
      console.info(result.ok ? result.message : `❌ ${result.message}`);
      if (!result.ok) process.exit(1);
      return;
    }

    default: {
      console.info(USAGE);
      console.info(`\n当前共 ${listMemories().length} 条记忆。`);
      return;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    logger.error({ err }, '记忆命令行失败');
    process.exit(1);
  }
}
