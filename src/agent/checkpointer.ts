import { QueryTypes } from 'sequelize';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  writesSortKey,
} from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { sequelize } from '../db.js';
import { utcNow } from '../lib/time.js';

/**
 * SQLite 检查点 —— **进程重启后能续跑的唯一保障**
 * （见 [12-b B6](../docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **不用进程内 MemorySaver** —— 那等于重启后状态全丢
 * （会话记录还在，但工具调用链断了）。
 *
 * ⚠️ **`thread_id` = 会话 id** —— 一一对应。
 *
 * 📌 **本项目自己实现 saver**（不是 LangGraph 官方 SQLite saver）：
 * 一是官方包不在依赖里，二是自己的实现能把表名与列名对齐 [05-a](../docs/05-a-数据模型-sqlite.md) 的约定。
 */

/** 库里的一行 */
interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  serde_type: string;
  data: string | null;
  created_at: string;
}

interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  task_path: string;
  idx: number;
  channel: string;
  serde_type: string;
  data: string | null;
}

/** 二进制 → base64（**存 TEXT，不依赖驱动的 BLOB 绑定**） */
function encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** base64 → 二进制 */
function decode(data: string): Buffer {
  return Buffer.from(data, 'base64');
}

/** 把 thread / ns / id 拼成主键（**分隔符用 `|` —— 这些 id 里不会出现**） */
function rowId(threadId: string, ns: string, checkpointId: string, kind: string): string {
  return `${threadId}|${ns}|${checkpointId}|${kind}`;
}

/**
 * 每个 thread **保留多少个检查点**。
 *
 * ⚠️ **为什么要有上限** ——
 * 每个检查点都存**完整的图状态**（全量消息 + 本轮注入的上下文），
 * 而图每跑一个节点就落一个检查点 →
 * **检查点行数随步数线性涨，每个体积又随对话变长 → 平方级**。
 *
 * 📌 **实测（改之前）**：36 条消息 / 23 个会话的库，
 * `graph_checkpoints` 攒了 **3,714 行 / 3.46 MB**，
 * 而真正的对话内容（`messages` 表）只有 5.9 KB —— **八成是检查点**。
 *
 * 📌 **留 8 个足够** ——
 * 恢复只需要「**最新的那个**检查点 + 它的 pending writes」，
 * 多留几个是为了「挂起期间又跑了几步」这种边缘情况。
 */
const KEEP_CHECKPOINTS = 8;

/**
 * 裁剪一个 thread 的旧检查点 —— **存储不再无限涨**。
 *
 * ⚠️ **检查点 id 是时间序的**（UUIDv6）——
 *    `ORDER BY checkpoint_id DESC` 就是「最新在前」，
 *    这一点 `fetchCheckpointRow` 已经依赖了。
 *
 * 📌 **先删检查点再删 pending writes** ——
 *    pending writes 挂在 `checkpoint_id` 上，
 *    检查点没了它就是孤儿（`getTuple` 读不到）。
 */
async function pruneThread(threadId: string): Promise<void> {
  // 📌 **LIMIT 直接写常量** —— 不是用户输入，没有注入面
  const keep = `SELECT checkpoint_id FROM graph_checkpoints
                 WHERE thread_id = :threadId AND type = 'checkpoint'
                 ORDER BY checkpoint_id DESC LIMIT ${KEEP_CHECKPOINTS}`;
  // ⚠️ **两个 type 一起删** —— 同一个 checkpoint_id 有 `checkpoint` 与 `metadata` 两行
  await sequelize.query(
    `DELETE FROM graph_checkpoints
      WHERE thread_id = :threadId
        AND checkpoint_id NOT IN (${keep})`,
    { replacements: { threadId } },
  );
  await sequelize.query(
    `DELETE FROM graph_checkpoint_writes
      WHERE thread_id = :threadId
        AND checkpoint_id NOT IN (${keep})`,
    { replacements: { threadId } },
  );
}

/**
 * 裁剪**所有** thread 的旧检查点 —— **启动时跑一次**。
 *
 * 📌 **为什么启动时也要跑** ——
 * 裁剪只发生在「有新检查点写入」的时候，
 * 那些再也不用的会话会一直占着空间（只有删会话才清）。
 */
export async function pruneAllThreads(): Promise<number> {
  const rows = await sequelize.query<{ thread_id: string }>(
    `SELECT DISTINCT thread_id FROM graph_checkpoints WHERE type = 'checkpoint'`,
    { type: QueryTypes.SELECT },
  );
  for (const row of rows) {
    await pruneThread(row.thread_id);
  }
  return rows.length;
}

/**
 * 回收**孤儿 thread** 的检查点 —— **会话早没了、检查点还在**。
 *
 * 📌 **它们是怎么来的** ——
 * 删会话走 `deleteSession` 时会连带删检查点，
 * 但**直接用 SQL 删会话行**的路径（`yarn data:clean`）绕过了那套清理，
 * 于是检查点就成了孤儿。
 *
 * 📌 **实测（本机库）** ——
 * 452 个会话 thread 里 **440 个是孤儿**，占掉 3.3 MB 检查点里的绝大部分。
 *
 * ⚠️ **只回收「既不是会话 id、也不是子代理 thread」的** ——
 *   - **会话 id**：会话还在 → thread 还有用（可能正挂起等确认）
 *   - **`subagent:` 开头**：子代理的独立 thread，
 *     父图挂起时还要靠它恢复（见 `agent/subagent.ts`）
 *   - **两者都不是**：`thread_id` 就是 `messageId`（**没建会话的裸聊**），
 *     那种轮次**没法恢复**（确认接口只认会话 id），留着的唯一作用是占空间
 */
export async function collectOrphanThreads(): Promise<number> {
  // ⚠️ **sessions 表可能不存在**（测试库、刚初始化）—— 那就跳过
  const tables = await sequelize.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`,
    { type: QueryTypes.SELECT },
  );
  if (tables.length === 0) return 0;

  const rows = await sequelize.query<{ thread_id: string }>(
    `SELECT DISTINCT thread_id FROM graph_checkpoints
      WHERE type = 'checkpoint'
        AND thread_id NOT LIKE 'subagent:%'
        AND thread_id NOT IN (SELECT id FROM sessions)`,
    { type: QueryTypes.SELECT },
  );
  for (const row of rows) {
    await sequelize.query('DELETE FROM graph_checkpoint_writes WHERE thread_id = :threadId', {
      replacements: { threadId: row.thread_id },
    });
    await sequelize.query('DELETE FROM graph_checkpoints WHERE thread_id = :threadId', {
      replacements: { threadId: row.thread_id },
    });
  }
  return rows.length;
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  /** 读一个检查点（**最新或指定 id**） */
  private async fetchCheckpointRow(
    threadId: string,
    ns: string,
    checkpointId?: string,
  ): Promise<CheckpointRow | undefined> {
    const rows = await sequelize.query<CheckpointRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, serde_type, data, created_at
         FROM graph_checkpoints
        WHERE thread_id = :threadId
          AND checkpoint_ns = :ns
          AND type = 'checkpoint'
          ${checkpointId ? 'AND checkpoint_id = :checkpointId' : ''}
        ORDER BY checkpoint_id DESC
        LIMIT 1`,
      {
        replacements: { threadId, ns, ...(checkpointId ? { checkpointId } : {}) },
        type: QueryTypes.SELECT,
      },
    );
    return rows[0];
  }

  /** 读元数据 */
  private async fetchMetadataRow(
    threadId: string,
    ns: string,
    checkpointId: string,
  ): Promise<CheckpointRow | undefined> {
    const rows = await sequelize.query<CheckpointRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, serde_type, data, created_at
         FROM graph_checkpoints
        WHERE thread_id = :threadId
          AND checkpoint_ns = :ns
          AND checkpoint_id = :checkpointId
          AND type = 'metadata'
        LIMIT 1`,
      { replacements: { threadId, ns, checkpointId }, type: QueryTypes.SELECT },
    );
    return rows[0];
  }

  /** 读待写入（**按 `writesSortKey` 排序 —— 顺序敏感**） */
  private async fetchWrites(
    threadId: string,
    ns: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    const rows = await sequelize.query<WriteRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, serde_type, data
         FROM graph_checkpoint_writes
        WHERE thread_id = :threadId
          AND checkpoint_ns = :ns
          AND checkpoint_id = :checkpointId`,
      { replacements: { threadId, ns, checkpointId }, type: QueryTypes.SELECT },
    );

    const keyed = rows.map((row) => ({
      key: writesSortKey(row.task_path, row.task_id, row.idx),
      row,
    }));
    keyed.sort((a, b) => compareWritesSortKeys(a.key, b.key));

    const out: CheckpointPendingWrite[] = [];
    for (const { row } of keyed) {
      if (!row.data) continue;
      const value = (await this.serde.loadsTyped(row.serde_type, decode(row.data))) as unknown;
      out.push([row.task_id, row.channel, value]);
    }
    return out;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) return undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const checkpointId = getCheckpointId(config);

    const row = await this.fetchCheckpointRow(threadId, ns, checkpointId);
    if (!row || !row.data) return undefined;

    const checkpoint = (await this.serde.loadsTyped(
      row.serde_type,
      decode(row.data),
    )) as unknown as Checkpoint;
    const metaRow = await this.fetchMetadataRow(threadId, ns, row.checkpoint_id);
    const metadata = metaRow?.data
      ? ((await this.serde.loadsTyped(metaRow.serde_type, decode(metaRow.data))) as unknown as CheckpointMetadata)
      : undefined;
    const pendingWrites = await this.fetchWrites(threadId, ns, row.checkpoint_id);

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      pendingWrites,
      // ⚠️ **`exactOptionalPropertyTypes`** —— 不能显式写 `metadata: undefined`
      ...(metadata ? { metadata } : {}),
    };
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const limit = options?.limit;
    // ⚠️ **`before` = 只列这个检查点之前的** —— 与 MemorySaver 语义一致
    const before = options?.before?.configurable?.checkpoint_id as string | undefined;
    const filter = options?.filter;

    const rows = await sequelize.query<CheckpointRow>(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, serde_type, data, created_at
         FROM graph_checkpoints
        WHERE type = 'checkpoint'
          ${threadId ? 'AND thread_id = :threadId' : ''}
          ${ns ? 'AND checkpoint_ns = :ns' : ''}
          ${before ? 'AND checkpoint_id < :before' : ''}
        ORDER BY checkpoint_id DESC`,
      {
        replacements: {
          ...(threadId ? { threadId } : {}),
          ...(ns ? { ns } : {}),
          ...(before ? { before } : {}),
        },
        type: QueryTypes.SELECT,
      },
    );

    let remaining = limit;
    for (const row of rows) {
      if (remaining !== undefined) {
        if (remaining <= 0) break;
        remaining -= 1;
      }
      if (!row.data) continue;
      const checkpoint = (await this.serde.loadsTyped(
        row.serde_type,
        decode(row.data),
      )) as unknown as Checkpoint;
      const metaRow = await this.fetchMetadataRow(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
      );
      const metadata = metaRow?.data
        ? ((await this.serde.loadsTyped(metaRow.serde_type, decode(metaRow.data))) as unknown as CheckpointMetadata)
        : undefined;
      if (filter) {
        const matches = Object.entries(filter).every(
          ([key, value]) => (metadata as Record<string, unknown> | undefined)?.[key] === value,
        );
        if (!matches) continue;
      }
      const pendingWrites = await this.fetchWrites(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
      );
      yield {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        pendingWrites,
        ...(metadata ? { metadata } : {}),
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: Record<string, unknown>,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) {
      throw new Error(
        '写检查点失败：config 里没有 thread_id —— 用 checkpointer 时必须传 configurable.thread_id',
      );
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const prepared = copyCheckpoint(checkpoint);
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null;

    const [[ckType, ckBytes], [mdType, mdBytes]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ]);
    const now = utcNow();

    await sequelize.query(
      `INSERT OR REPLACE INTO graph_checkpoints
         (id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, serde_type, data, created_at)
       VALUES
         (:id1, :threadId, :ns, :checkpointId, :parentId, 'checkpoint', :serdeType, :data, :now),
         (:id2, :threadId, :ns, :checkpointId, :parentId, 'metadata', :mdSerdeType, :mdData, :now)`,
      {
        replacements: {
          id1: rowId(threadId, ns, checkpoint.id, 'checkpoint'),
          id2: rowId(threadId, ns, checkpoint.id, 'metadata'),
          threadId,
          ns,
          checkpointId: checkpoint.id,
          parentId,
          serdeType: ckType,
          data: encode(ckBytes),
          mdSerdeType: mdType,
          mdData: encode(mdBytes),
          now,
        },
      },
    );

    // 📌 **写完就裁剪旧的** —— 每个检查点都存全量状态，
    //    不裁剪的话存储是**平方级**涨的（见 `KEEP_CHECKPOINTS` 的注释）
    await pruneThread(threadId);

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) {
      throw new Error('写待写入失败：config 里没有 thread_id');
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!checkpointId) {
      throw new Error('写待写入失败：config 里没有 checkpoint_id');
    }

    const now = utcNow();
    for (const [index, write] of writes.entries()) {
      const [channel, value] = write;
      const [serdeType, bytes] = await this.serde.dumpsTyped(value);
      const writeIdx = WRITES_IDX_MAP[channel] ?? index;
      const id = rowId(threadId, ns, checkpointId, `w:${taskId}:${writeIdx}:${channel}`);
      // ⚠️ **负数序号（`__resume__` / `__interrupt__`）要能覆盖** ——
      //    第二次恢复的决定要替换掉第一次的；
      //    普通序号（≥ 0）**已存在就不覆盖** —— 与 LangGraph 自带的
      //    MemorySaver 语义一致（同一个任务的同一次写入只算一次）
      await sequelize.query(
        `INSERT OR ${writeIdx < 0 ? 'REPLACE' : 'IGNORE'} INTO graph_checkpoint_writes
           (id, thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, serde_type, data, created_at)
         VALUES
           (:id, :threadId, :ns, :checkpointId, :taskId, :taskPath, :idx, :channel, :serdeType, :data, :now)`,
        {
          replacements: {
            id,
            threadId,
            ns,
            checkpointId,
            taskId,
            taskPath: taskPath ?? '',
            idx: writeIdx,
            channel,
            serdeType,
            data: encode(bytes),
            now,
          },
        },
      );
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await sequelize.query(
      'DELETE FROM graph_checkpoint_writes WHERE thread_id = :threadId',
      { replacements: { threadId } },
    );
    await sequelize.query('DELETE FROM graph_checkpoints WHERE thread_id = :threadId', {
      replacements: { threadId },
    });
  }
}

let cachedSaver: SqliteCheckpointSaver | undefined;

/** 全局 saver（**进程内一份**） */
export function getCheckpointSaver(): SqliteCheckpointSaver {
  if (!cachedSaver) cachedSaver = new SqliteCheckpointSaver();
  return cachedSaver;
}
