/**
 * 统一错误 —— **全项目只有一个错误体**（见 [03-b §B.10](../docs/03-b-技术栈-后端栈.md)）。
 *
 * ```json
 * { "error": { "code": "MODEL_NOT_CONFIGURED", "message": "还没配置模型，去改 .env 的 LLM_MODEL" } }
 * ```
 *
 * ⚠️ **密钥不许出现在 message 里** —— `sanitizeMessage()` 会把 `.env` 里的
 * API Key 打码，防止上游 SDK 把请求头带进错误信息。
 */

/** 状态码 → 前端文案由前端兜（见 `web/lib/apiError.ts`），这里只给机器可读的 code */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }

  /** 统一的响应体 */
  toBody(): { error: { code: string; message: string } } {
    // ⚠️ **message 也要过打码** —— 上游 SDK 偶尔把请求头塞进错误信息
    //    （见 [12-a A3](../docs/12-a-需求-应用外壳与上下文.md)）
    return { error: { code: this.code, message: sanitizeMessage(this.message) } };
  }
}

/** 需要打码的密钥（进程内注册，**不落库、不写日志**） */
const secrets = new Set<string>();

/** 注册一个「出现即打码」的字符串（启动时把 API Key 塞进来） */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

/**
 * 打码 —— 把消息里出现的密钥换成 `***`。
 *
 * ⚠️ **默认打码 6 位以上的疑似密钥**（`sk-`、`Bearer `、`api_key=` 等），
 * 防止某个 SDK 把请求头原样塞进错误信息。
 */
export function sanitizeMessage(message: string): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('***');
  }
  return out
    .replace(/(sk-[A-Za-z0-9._-]{6,})/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/((?:api[_-]?key|authorization|token)\s*[:=]\s*)\S{6,}/gi, '$1***');
}
