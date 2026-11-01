import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetch } from '../../src/lib/security/egress';

/* eslint-disable @typescript-eslint/require-await --
 * 注入的 `resolve` 是 **异步函数**（签名要求返回 Promise），
 * 它只返回结果、没有 await。
 */

/**
 * 出网校验的 **IP 钉住** 测试 —— **纯本地，不发外网请求**。
 *
 * ⚠️ **这条守的是 DNS rebinding** ——
 *   攻击者控制 DNS：第一次解析给公网 IP（校验通过），
 *   第二次解析给 `127.0.0.1`（请求真的连到本机）。
 *   所以校验完必须**把连接钉到已校验过的那个 IP**。
 *
 * 📌 **怎么证明钉住了** —— 用一个**真实解析不出来**的域名
 *   （`pinned.test`），只靠注入的 `resolve` 才给得出 IP：
 *   如果代码二次解析（走系统 DNS），这个域名必然 `ENOTFOUND`；
 *   请求能通，就说明走的是我们钉的地址。
 */

let server: Server;
let port = 0;

/** 服务端看到的 Host 头（**证明 Host 走的是域名而不是 IP**） */
let seenHost = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seenHost = req.headers.host ?? '';
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('你好');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('出网：IP 钉住（DNS rebinding）', () => {
  it('⚠️ 连的是已校验的 IP，Host 头仍是域名', async () => {
    const response = await guardedFetch(`http://pinned.test:${port}/hello`, {
      allowPrivate: true,
      // 📌 **只认这个注入的解析结果** —— 系统 DNS 解析不了 pinned.test
      resolve: async () => ['127.0.0.1'],
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe('你好');
    // ⚠️ **Host 头必须是域名** —— 否则是「连到 IP 再改 Host」的野路子
    expect(seenHost).toBe(`pinned.test:${port}`);
  });

  it('⚠️ 钉的地址不可达时报错，不改用系统 DNS', async () => {
    await expect(
      guardedFetch('http://pinned.test:1/hello', {
        allowPrivate: true,
        resolve: async () => ['203.0.113.7'],
        timeoutMs: 3000,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/请求失败|请求超时/);
  });
});
