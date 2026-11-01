import { config } from '../src/config.js';

/**
 * 端点支不支持「提示词缓存」的探测 —— `yarn cache:probe`
 *
 * ```bash
 * yarn cache:probe
 * ```
 *
 * 📌 **为什么需要它** ——
 * Anthropic 的提示词缓存是**前缀缓存**，
 * 而「兼容端点」对它的支持分成三档：
 *
 * | 档位 | 表现 | Atlas 的应对 |
 * | ---- | ---- | ------------- |
 * | 完整支持 | 第二次调用 `cache_read_input_tokens > 0` | 拆分稳定段 → 真的省钱 |
 * | 报错 | 返回 400 | `model-stream.ts` 自动去掉标记重试 |
 * | **静默失效** | **正常返回，但 `cache_read_input_tokens` 恒为 0** | ⚠️ **看不出来** |
 *
 * ⚠️ **第三档最坑** —— 智谱的 Anthropic 兼容端点就是这一档：
 * 接受 `cache_control`、不报错、但**缓存根本没生效**。
 * 开着 `LLM_PROMPT_CACHE` 会让人以为在省钱，其实一分没省。
 *
 * 📌 **这个脚本就是来戳穿第三档的** ——
 * 发两次**一模一样**的长前缀请求，看第二次有没有命中。
 */

/** 一段够长的稳定前缀（**太短可能达不到端点的最小可缓存长度**） */
function stablePrefix(): string {
  return '这是一段用于探测提示词缓存的稳定前缀内容，包含中文字符与 English words。\n'.repeat(
    1_200,
  );
}

interface ProbeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 发一次请求，返回用量 */
async function probe(url: string, headers: Record<string, string>, body: unknown): Promise<{
  status: number;
  usage: ProbeUsage;
  error?: string;
}> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    usage?: ProbeUsage;
    error?: { message?: string };
  };
  return {
    status: res.status,
    usage: json.usage ?? {},
    ...(json.error?.message ? { error: json.error.message } : {}),
  };
}

async function main(): Promise<void> {
  const base = config.LLM_BASE_URL;
  const key = config.LLM_API_KEY;
  const model = config.LLM_MODEL;

  if (!base || !key || !model) {
    console.error('✖ 还没配模型 —— 先改 .env 的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
    process.exit(1);
  }

  const url = `${base.replace(/\/+$/, '')}/v1/messages`;
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const prefix = stablePrefix();
  const body = {
    model,
    max_tokens: 16,
    system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '回复「好」' }],
  };

  console.info(`端点：${url}`);
  console.info(`模型：${model}`);
  console.info(`稳定前缀：约 ${prefix.length} 字符\n`);

  const first = await probe(url, headers, body);
  if (first.status !== 200) {
    console.error(`✖ 第一次请求就失败了（HTTP ${first.status}）：${first.error ?? ''}`);
    console.error('  → 这个端点连基础请求都不认，没法测缓存。');
    process.exit(1);
  }
  console.info(`第 1 次：HTTP 200  usage=${JSON.stringify(first.usage)}`);

  const second = await probe(url, headers, body);
  if (second.status !== 200) {
    console.error(`✖ 第二次请求失败（HTTP ${second.status}）：${second.error ?? ''}`);
    console.error('  → 端点报错 = 它**不支持** cache_control（Atlas 会自动去掉标记重试，不影响使用）。');
    process.exit(1);
  }
  console.info(`第 2 次：HTTP 200  usage=${JSON.stringify(second.usage)}\n`);

  const hit = second.usage.cache_read_input_tokens ?? 0;
  if (hit > 0) {
    console.info(`✔ 这个端点**支持**提示词缓存 —— 第 2 次命中了 ${hit} 个缓存 token。`);
    console.info('  → 把 .env 的 LLM_PROMPT_CACHE 改成 true 就能省钱。');
    return;
  }

  console.info('✖ 这个端点**静默失效**：接受 cache_control、不报错，但缓存没生效');
  console.info('  （`cache_read_input_tokens` 恒为 0 —— 智谱的兼容端点就是这一档）。');
  console.info('  → 保持 LLM_PROMPT_CACHE=false 即可；');
  console.info('  → 换到真正支持缓存的端点（Anthropic 官方等）时再打开。');
}

main().catch((err) => {
  console.error('探测失败：', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
