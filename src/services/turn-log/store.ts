import { nanoid } from 'nanoid';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db.js';
import { logger } from '../../logger.js';
import { maskToJson } from '../../lib/security/mask.js';
import { utcNow, utcToIso } from '../../lib/time.js';
import {
  TURN_LOG_TYPE_LABELS,
  type AppendEventInput,
  type SessionTurnLog,
  type TurnLogEventView,
  type TurnLogStatus,
  type TurnLogTurnView,
} from './types.js';

/**
 * 会话全链路日志 —— **存储层**
 * （见 [12-e E7](../../docs/12-e-需求-观测安全与验收.md)）。
 *
 * 📌 **两张表**：`session_turn_logs`（一轮一行）+ `session_turn_log_events`（事件流）。
 *    查询时按 `session_id` 聚合 → 「**一个会话一份日志**」。
 *
 * ⚠️ **写日志绝不能打断对话** —— 所有写失败只记日志（跟 `recordToolCall` 一个规矩）。
 * ⚠️ **payload 一律脱敏后入库** —— 走 `lib/security/mask.ts`。
 */

/**
 * 顺序号 —— **全局单调递增**。
 *
 * 📌 **用毫秒时间戳打底** —— 进程重启后计数器会归零，
 *    但时间戳不会 → 重启后写的事件仍然排在旧事件后面。
 * ⚌ **同一毫秒内多次写** → 自增一格，不会撞号。
 */
let lastSeq = Date.now();

/** 下一个顺序号 */
function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now());
  return lastSeq;
}

/**
 * 开一轮（**幂等** —— 同一轮被开两次就当没开过）。
 *
 * 📌 **主键用 `turnId`（= assistant 消息 id）** ——
 *    一轮 = 一条 assistant 消息，工具循环与中断恢复都算同一轮。
 */
export async function startTurn(input: {
  turnId: string;
  sessionId: string;
  model?: string | undefined;
}): Promise<void> {
  try {
    await sequelize.query(
      `INSERT INTO session_turn_logs (id, session_id, message_id, status, model, started_at, ended_at)
       VALUES (:id, :session_id, :message_id, 'running', :model, :started_at, NULL)
       ON CONFLICT(id) DO UPDATE SET model = COALESCE(excluded.model, session_turn_logs.model)`,
      {
        replacements: {
          id: input.turnId,
          session_id: input.sessionId,
          message_id: input.turnId,
          model: input.model ?? null,
          started_at: utcNow(),
        },
      },
    );
  } catch (err) {
    logger.error({ err, turnId: input.turnId }, '轮次日志开启失败');
  }
}

/**
 * 写一条事件。
 *
 * ⚠️ **按 `(turn_id, event_key)` upsert** —— 图节点在恢复时会重跑一遍
 *    （见 [12-b B5](../../docs/12-b-需求-对话与编排.md)），
 *    同一个事件要能**重写**而不是**重一行**。
 */
export async function appendEvent(input: AppendEventInput): Promise<void> {
  try {
    await sequelize.query(
      `INSERT INTO session_turn_log_events
         (id, turn_id, session_id, seq, type, event_key, title, payload, created_at)
       VALUES (:id, :turn_id, :session_id, :seq, :type, :event_key, :title, :payload, :created_at)
       ON CONFLICT(turn_id, event_key) DO UPDATE SET
         seq = excluded.seq, title = excluded.title,
         payload = excluded.payload, created_at = excluded.created_at`,
      {
        replacements: {
          id: nanoid(),
          turn_id: input.turnId,
          session_id: input.sessionId,
          seq: nextSeq(),
          type: input.type,
          event_key: input.eventKey,
          title: input.title,
          // ⚠️ **落库前脱敏** —— 工具出参、模型请求体里都可能有密钥
          payload: input.payload === undefined ? null : maskToJson(input.payload),
          created_at: utcNow(),
        },
      },
    );
  } catch (err) {
    logger.error({ err, type: input.type }, '轮次日志事件写入失败');
  }
}

/** 收尾（**这一轮结束了**） */
export async function finishTurn(
  turnId: string,
  status: TurnLogStatus,
  model?: string,
): Promise<void> {
  try {
    await sequelize.query(
      `UPDATE session_turn_logs
         SET status = :status, ended_at = :ended_at,
             model = COALESCE(:model, model)
       WHERE id = :id`,
      { replacements: { id: turnId, status, ended_at: utcNow(), model: model ?? null } },
    );
  } catch (err) {
    logger.error({ err, turnId }, '轮次日志收尾失败');
  }
}

/** 轮次表的一行 */
interface TurnRow {
  id: string;
  session_id: string;
  message_id: string;
  status: string;
  model: string | null;
  started_at: string;
  ended_at: string | null;
}

/** 事件表的一行 */
interface TurnEventRow {
  turn_id: string;
  seq: number;
  type: string;
  title: string;
  payload: string | null;
  created_at: string;
}

/** 解析一行事件的 payload（**存的是 JSON 文本**） */
function parsePayload(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 读一个会话的完整日志。
 *
 * 📌 **按 `seq` 排序** —— 事件是并发写的，写入完成顺序不等于发生顺序，
 *    `seq` 才是「真实顺序」。
 */
export async function readSessionLog(sessionId: string): Promise<SessionTurnLog> {
  const [turnRows, eventRows] = await Promise.all([
    sequelize.query(
      `SELECT id, session_id, message_id, status, model, started_at, ended_at
         FROM session_turn_logs WHERE session_id = :sessionId ORDER BY started_at ASC`,
      { replacements: { sessionId }, type: QueryTypes.SELECT },
      // ⚠️ **SELECT 直接返回行数组**（不是 `[rows, meta]` 元组）
    ) as unknown as Promise<TurnRow[]>,
    sequelize.query(
      `SELECT turn_id, seq, type, title, payload, created_at
         FROM session_turn_log_events WHERE session_id = :sessionId ORDER BY seq ASC`,
      { replacements: { sessionId }, type: QueryTypes.SELECT },
    ) as unknown as Promise<TurnEventRow[]>,
  ]);

  const byTurn = new Map<string, TurnLogEventView[]>();
  for (const row of eventRows) {
    const list = byTurn.get(row.turn_id) ?? [];
    list.push({
      seq: row.seq,
      type: row.type,
      label: TURN_LOG_TYPE_LABELS[row.type as keyof typeof TURN_LOG_TYPE_LABELS] ?? row.type,
      title: row.title,
      payload: parsePayload(row.payload),
      createdAt: utcToIso(row.created_at) ?? row.created_at,
    });
    byTurn.set(row.turn_id, list);
  }

  const turns: TurnLogTurnView[] = turnRows.map((row) => ({
    id: row.id,
    status: row.status === 'finished' || row.status === 'failed' ? row.status : 'running',
    model: row.model,
    startedAt: utcToIso(row.started_at) ?? row.started_at,
    endedAt: utcToIso(row.ended_at),
    events: byTurn.get(row.id) ?? [],
  }));

  // ⚠️ **孤儿事件不能丢** —— 有事件却没有轮次行，说明哪条路径漏了「开一轮」。
  //    硬丢的话「所有事件都保存」就是空话；这里补一个「状态未知」的轮次。
  const known = new Set(turnRows.map((row) => row.id));
  for (const [turnId, events] of byTurn) {
    if (known.has(turnId)) continue;
    const first = events[0];
    turns.push({
      id: turnId,
      status: 'unknown',
      model: null,
      startedAt: first?.createdAt ?? '',
      endedAt: events.at(-1)?.createdAt ?? null,
      events,
    });
  }

  return { sessionId, turns };
}

/** 删一个会话的全部日志（**删会话时级联调用**） */
export async function deleteTurnLogs(sessionId: string): Promise<void> {
  await sequelize.query('DELETE FROM session_turn_log_events WHERE session_id = :sessionId', {
    replacements: { sessionId },
  });
  await sequelize.query('DELETE FROM session_turn_logs WHERE session_id = :sessionId', {
    replacements: { sessionId },
  });
}
