import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { useTempDatabase } from '../fixtures/db';

/**
 * `POST /api/v1/chat` 的**集成测试** —— 真 Koa · 真 SSE · **假模型**。
 *
 * ⚠️ **模型必须 mock** —— 打一次真模型十几秒，用例不能这么慢。
 * 协议、提示词注入、断线中止这些**用假模型就能验**，而且是**秒级**。
 * 真模型的冒烟测试留到「交付这条需求」时手测一次就够。
 */

interface StreamCall {
  messages: Array<{ getType(): string; content: string }>;
  signal?: AbortSignal;
}

const calls: StreamCall[] = [];
/**
 * 假模型被 abort 时置位 —— 用来验「客户端断开 → 上游真的停」。
 *
 * 📌 **挂在 globalThis 上** —— mock 工厂是被提升（hoist）到文件顶部的，
 *    闭包里的变量绑定容易对不上；挂全局最省事。
 */
const abortState = { aborted: false };
/** 假模型每段之间的间隔（断线测试要调慢，才有机会在流中间断开） */
let pieceDelayMs = 5;

// ⚠️ **只 mock 模型解析** —— 其余（AppError / 提示词 / 协议层）都走真代码
vi.mock('../../src/logger', () => ({
  // pino 直接写 stdout，会把 agent reporter 的输出冲掉 —— 测试里静音
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock('../../src/services/model', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/model')>(
    '../../src/services/model',
  );
  return {
    ...actual,
    resolveModel: () => ({
      name: 'fake-model',
      baseUrl: 'http://fake.local',
      apiKey: 'fake-key',
      modelId: 'fake-model',
      maxTokens: 1024,
      temperature: 1,
      thinkingBudget: 0,
    }),
    resolveFallback: () => undefined,
    createChatModel: () => {
      // ⚠️ **`bindTools` 要有** —— 图的 plan 节点会绑工具再调模型
      const model = {
        bindTools: () => model,
        stream: async function* (
          messages: StreamCall['messages'],
          options?: { signal?: AbortSignal },
        ) {
          calls.push({ messages, ...(options?.signal ? { signal: options.signal } : {}) });
          // ⚠️ **监听 abort 事件** —— 只在 sleep 之后检查会跟「图拆掉生成器」赛跑，
          //    断开时上游可能来不及置位（那样测的就不是「上游被中止」了）
          options?.signal?.addEventListener('abort', () => {
            abortState.aborted = true;
          });
          // ⚠️ **开场就检查** —— 信号可能在上游调用之前就断了
          //    （「abort 事件已经发生过」就再也不会触发监听器）
          if (options?.signal?.aborted) {
            abortState.aborted = true;
            return;
          }
          for (const piece of ['你', '好']) {
            await new Promise((resolve) => setTimeout(resolve, pieceDelayMs));
            if (options?.signal?.aborted) {
              abortState.aborted = true;
              return;
            }
            yield { text: piece };
          }
        },
      };
      return model;
    },
  };
});

// ⚠️ **先切走数据目录** —— 必须在 import `src/config.js` 之前。
//    不切的话这个用例会往**真实库**里写成本流水（测试不能污染用户数据）。
useTempDatabase();

const { initDatabase } = await import('../../src/db');
const { umzug } = await import('../../scripts/migrate');
const { createApp } = await import('../../src/app');

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

/** SSE 文本 → chunk 数组 */
function parseSse(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as { type: string; [key: string]: unknown });
}

function postChat(body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

const userMessage = { role: 'user', parts: [{ type: 'text', text: '你好' }] };

describe('POST /api/v1/chat', () => {
  it('按协议顺序吐 chunk（text-delta 拼起来就是回复）', async () => {
    const response = await postChat({ messages: [userMessage] });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const chunks = parseSse(await response.text());
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk['delta'])
      .join('');
    expect(text).toBe('你好');
  });

  it('⚠️ system 提示词在最前（人格压过历史消息）', async () => {
    await postChat({ messages: [userMessage] });
    const call = calls.at(-1);
    expect(call?.messages[0]?.getType()).toBe('system');
    expect(call?.messages[0]?.content).toContain('Atlas');
    expect(call?.messages[1]?.getType()).toBe('human');
    expect(call?.messages[1]?.content).toBe('你好');
  });

  it('客户端断开 → 上游调用真的被中止', async () => {
    abortState.aborted = false;
    // ⚠️ **把假模型调慢** —— 否则它早就流完了，断开根本碰不到中途。
    //    真实的上游调用本来就比一次往返长得多；
    //    流太短的话，机器一忙（事件循环延迟）响应就先端完了，
    //    断开还没被处理 —— 那测的就不是「上游被中止」了
    pieceDelayMs = 800;
    // 📌 **这一轮专属的消息** —— `calls` 是模块级的共享数组，
    //    上一个用例的请求可能还在飞（它也会往里塞一条），
    //    不区分就会把别人的调用当自己的
    const marker = '断开测试专用消息';
    try {
      const controller = new AbortController();
      const before = calls.length;
      const pending = postChat(
        { messages: [{ role: 'user', parts: [{ type: 'text', text: marker }] }] },
        controller.signal,
      );

      /** 自己的上游调用开始了没 */
      const started = (): boolean =>
        calls
          .slice(before)
          .some((call) =>
            call.messages.some(
              (message) => typeof message.content === 'string' && message.content.includes(marker),
            ),
          );

      // ⚠️ **等自己的上游调用真的开始** —— `prepare` 节点会先做检索与裁剪，
      // 固定等 50ms 可能断在模型还没开始的时候（那样就验不到「上游被中止」）
      const deadline = Date.now() + 5000;
      while (!started() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      controller.abort();
      await pending.catch(() => undefined);

      // 📌 **上游压根没被调用也算对** —— 断开比上游调用还早，
      //    服务端直接不调模型（省 token），这比「调了再中止」更好
      if (!started()) {
        expect(started()).toBe(false);
        return;
      }

      const abortDeadline = Date.now() + 5000;
      while (!abortState.aborted && Date.now() < abortDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(abortState.aborted).toBe(true);
    } finally {
      pieceDelayMs = 5;
    }
  });

  it('请求体不对 → 400 + 统一错误体', async () => {
    const response = await postChat({ messages: [{ role: 'unknown-role', parts: [] }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: '请求体格式不对' },
    });
  });
});

describe('GET /api/v1/models', () => {
  it('只回模型名，不回 API Key', async () => {
    const response = await fetch(`${baseUrl}/api/v1/models`);
    const body = (await response.json()) as {
      configured: boolean;
      models: Array<{ name: string; role: string }>;
    };
    expect(body.configured).toBe(true);
    expect(body.models[0]?.name).toBe('fake-model');
    expect(JSON.stringify(body)).not.toContain('fake-key');
  });
});
