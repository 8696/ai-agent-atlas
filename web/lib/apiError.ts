/**
 * 错误文案 —— **全前端唯一一份**（见 [03-c §C.8](../docs/03-c-技术栈-前端栈.md)）。
 *
 * ⚠️ **不要在各个 api 模块里各抄一份 `errorMessage`** ——
 * 抄着抄着就会出现「用户看到英文 `Forbidden`」这种事故。
 */

/** 状态码 → 文案 */
const STATUS_TEXT: Record<number, string> = {
  400: '请求参数不对',
  403: '没有权限',
  404: '接口不存在',
  429: '请求太频繁，稍后再试',
  500: '服务内部错误，看后端日志',
  502: '后端没连上（网关错误），确认后端在跑',
  503: '服务暂时不可用',
  504: '后端响应超时',
};

/** 后端统一错误体 */
interface BackendErrorBody {
  error?: { code?: string; message?: string };
}

interface ErrorLike {
  message?: unknown;
  statusCode?: number;
  response?: { status?: number; data?: unknown };
}

/** 从「后端错误体」里取文案 —— 取不到返回 null */
function fromBackendBody(data: unknown): { code?: string; message: string } | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as BackendErrorBody;
  const message = body.error?.message;
  if (!message) return null;
  return body.error?.code ? { code: body.error.code, message } : { message };
}

/**
 * 错误 → 给用户看的一句话。
 *
 * ⚠️ **AI SDK 的 `APICallError.message` 是响应体原文**（可能是一段 JSON），
 * 所以先按 JSON 解析一次，取 `error.message`。
 */
export function toUserMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;

  const err = error as ErrorLike;

  const fromResponse = fromBackendBody(err.response?.data);
  if (fromResponse) return fromResponse.message;

  const raw = typeof err.message === 'string' ? err.message : '';
  if (raw) {
    try {
      const parsed = fromBackendBody(JSON.parse(raw));
      if (parsed) return parsed.message;
    } catch {
      // 不是 JSON —— 按原文处理
    }
  }

  const status = err.response?.status ?? err.statusCode;

  // ⚠️ **网络层失败**（后端没起来 / 断网）—— AI SDK 的兜底文案是英文
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return '连不上后端，确认后端在跑（yarn dev:backend）';
  }

  if (status && STATUS_TEXT[status]) return STATUS_TEXT[status];
  if (status) return `服务返回 ${status}`;

  return raw || '出错了';
}

/** 是不是「还没配置模型」 */
export function isModelNotConfigured(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as ErrorLike;
  const fromResponse = fromBackendBody(err.response?.data);
  if (fromResponse?.code === 'MODEL_NOT_CONFIGURED') return true;
  const raw = typeof err.message === 'string' ? err.message : '';
  try {
    return fromBackendBody(JSON.parse(raw))?.code === 'MODEL_NOT_CONFIGURED';
  } catch {
    return false;
  }
}
