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
