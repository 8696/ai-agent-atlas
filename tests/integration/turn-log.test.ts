import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { QueryTypes } from 'sequelize';
import { useTempDatabase } from '../fixtures/db';

/**
 * 会话全链路日志的集成测试 —— **真 Koa · 真 SQLite（临时库）**。
 *
 * 覆盖：写事件 · 幂等重写 · 脱敏 · 顺序 · 删会话级联 · 斜杠命令。
 */

// ⚠️ **静音日志** —— pino 直接写 stdout，会把 agent reporter 的输出冲掉
vi.mock('../../src/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// ⚠️ **先切走数据目录** —— 必须在 import `src/db.js` 之前
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');
const { appendEvent, finishTurn, readSessionLog, startTurn } =
  await import('../../src/services/turn-log/store');
const { renderSessionLog } = await import('../../src/services/turn-log/render');
const { sequelize } = await import('../../src/db');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await initDatabase();
  await umzug.up();
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

async function createSession(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe('会话全链路日志（[12-e E7](../docs/12-e-需求-观测安全与验收.md)）', () => {
  it('一轮 + 若干事件 → 读出来顺序正确', async () => {
    const sessionId = await createSession();
    const turnId = 'turn-order-1';

    await startTurn({ turnId, sessionId, model: 'test-model' });
    await appendEvent({
      turnId,
      sessionId,
      type: 'request.received',
      eventKey: 'request.received',
      title: '收到请求',
      payload: { userText: '你好' },
    });
    await appendEvent({
      turnId,
      sessionId,
      type: 'llm.request',
      eventKey: 'llm.request:0',
      title: '第 1 次调模型',
      payload: { model: 'test-model', systemPrompt: '系统提示词' },
    });
    await appendEvent({
      turnId,
      sessionId,
      type: 'llm.response',
      eventKey: 'llm.response:0',
      title: '第 1 次模型响应',
      payload: { text: '回答' },
    });
    await finishTurn(turnId, 'finished', 'test-model');

    const log = await readSessionLog(sessionId);
    expect(log.turns).toHaveLength(1);
    const turn = log.turns[0];
    expect(turn?.status).toBe('finished');
    expect(turn?.model).toBe('test-model');
    expect(turn?.events.map((event) => event.type)).toEqual([
      'request.received',
      'llm.request',
      'llm.response',
    ]);
    // 📌 **事件类型带中文名** —— 前端直接用
    expect(turn?.events[0]?.label).toBe('收到请求');
  });

  it('⚠️ 同一个 event_key 重写而不是重一行（节点恢复时会重跑）', async () => {
    const sessionId = await createSession();
    const turnId = 'turn-upsert-1';

    await startTurn({ turnId, sessionId });
    await appendEvent({
      turnId,
      sessionId,
      type: 'tool.execute',
      eventKey: 'tool.execute:call-1',
      title: '第一次',
      payload: { status: 'running' },
    });
    await appendEvent({
      turnId,
      sessionId,
      type: 'tool.execute',
      eventKey: 'tool.execute:call-1',
      title: '第二次',
      payload: { status: 'success' },
    });

    const log = await readSessionLog(sessionId);
    const events = log.turns[0]?.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('第二次');
    expect((events[0]?.payload as { status: string }).status).toBe('success');
  });

  it('⚠️ payload 里的密钥要打码后再入库', async () => {
    const sessionId = await createSession();
    const turnId = 'turn-mask-1';

    await startTurn({ turnId, sessionId });
    await appendEvent({
      turnId,
      sessionId,
      type: 'llm.request',
      eventKey: 'llm.request:0',
      title: '模型请求',
      payload: { apiKey: 'sk-abcdef123456', text: '带 Bearer abcdef123456 的正文' },
    });

    const log = await readSessionLog(sessionId);
    const payload = log.turns[0]?.events[0]?.payload as Record<string, unknown>;
    expect(payload.apiKey).toBe('***');
    expect(String(payload.text)).not.toContain('abcdef123456');
  });

  it('GET /sessions/:id/log → 一份完整日志', async () => {
    const sessionId = await createSession();
    const turnId = 'turn-api-1';
    await startTurn({ turnId, sessionId });
    await appendEvent({
      turnId,
      sessionId,
      type: 'request.received',
      eventKey: 'request.received',
      title: '收到请求',
      payload: { userText: '你好' },
    });

    const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/log`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { id: string };
      turns: Array<{ id: string; events: Array<{ type: string }> }>;
    };
    expect(body.session.id).toBe(sessionId);
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]?.events[0]?.type).toBe('request.received');
  });

  it('⚠️ 删会话 → 日志一并清掉，不留孤儿行', async () => {
    const sessionId = await createSession();
    const turnId = 'turn-cascade-1';
    await startTurn({ turnId, sessionId });
    await appendEvent({
      turnId,
      sessionId,
      type: 'request.received',
      eventKey: 'request.received',
      title: '收到请求',
      payload: {},
    });

    const before = await sequelize.query(
      'SELECT COUNT(*) AS n FROM session_turn_log_events WHERE session_id = :id',
      { replacements: { id: sessionId }, type: QueryTypes.SELECT },
    );
    expect(Number((before[0] as unknown as { n: number }).n)).toBe(1);

    const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    const log = await readSessionLog(sessionId);
    expect(log.turns).toHaveLength(0);
    const after = await sequelize.query(
      'SELECT COUNT(*) AS n FROM session_turn_log_events WHERE session_id = :id',
      { replacements: { id: sessionId }, type: QueryTypes.SELECT },
    );
    expect(Number((after[0] as unknown as { n: number }).n)).toBe(0);
  });

  it('/log 斜杠命令 → 渲染成摘要（零 LLM 调用）', async () => {
    const sessionId = await createSession();
    const turnId = 'turn-cmd-1';
    await startTurn({ turnId, sessionId, model: 'test-model' });
    await appendEvent({
      turnId,
      sessionId,
      type: 'llm.request',
      eventKey: 'llm.request:0',
      title: '第 1 次调模型',
      payload: { model: 'test-model', systemPrompt: '系统提示词', tools: [], messages: [] },
    });

    const response = await fetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', parts: [{ type: 'text', text: '/log' }] }],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('会话日志');
    expect(text).toContain('模型请求');
  });

  it('⚠️ 孤儿事件不能丢（有事件没轮次行 → 补一个「状态未知」的轮次）', async () => {
    const sessionId = await createSession();
    // 📌 **故意不开一轮** —— 模拟「哪条路径漏了开一轮」
    await appendEvent({
      turnId: 'orphan-turn-1',
      sessionId,
      type: 'request.received',
      eventKey: 'request.received',
      title: '收到请求',
      payload: { userText: '你好' },
    });

    const log = await readSessionLog(sessionId);
    expect(log.turns).toHaveLength(1);
    expect(log.turns[0]?.status).toBe('unknown');
    expect(log.turns[0]?.events).toHaveLength(1);
  });

  it('渲染：没有日志的会话给一句人话', () => {
    const rendered = renderSessionLog({ sessionId: 'x', turns: [] });
    expect(rendered).toContain('还没有日志');
  });
});
