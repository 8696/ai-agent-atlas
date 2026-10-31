import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * 假的 MCP server —— **测试用的 stdio server**
 * （见 [12-c C5](../../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **它是个真进程** —— `stdio` 传输会把它拉起来，
 *    这样「连接 → 发现工具 → 调用工具」整条链路都能被测到，
 *    而不是只测我们自己的 mock。
 *
 * 📌 **三个工具**：
 * - `echo` —— 回显一个字符串
 * - `add` —— 两数相加
 * - `boom` —— 故意报错（测错误路径）
 */

/** server 本体 */
const server = new Server(
  { name: 'atlas-test-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

/** 工具清单 */
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: '把传入的文本原样返回',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: '把两个数字相加',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
    {
      name: 'boom',
      description: '故意报错',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

/** 调用工具 */
server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo') {
    const text = typeof args?.text === 'string' ? args.text : '';
    return { content: [{ type: 'text', text }] };
  }
  if (name === 'add') {
    const a = Number(args?.a ?? 0);
    const b = Number(args?.b ?? 0);
    return { content: [{ type: 'text', text: String(a + b) }] };
  }
  if (name === 'boom') {
    return {
      content: [{ type: 'text', text: '这个工具故意失败' }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `没有这个工具：${name}` }],
    isError: true,
  };
});

// ⚠️ **stdio 传输要走 stdin/stdout** —— 日志一律走 stderr
await server.connect(new StdioServerTransport());
