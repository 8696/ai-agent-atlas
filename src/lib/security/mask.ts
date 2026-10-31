import { sanitizeMessage } from '../errors.js';

/**
 * 密钥打码 —— **写进历史库前的最后一道防线**（见 [10 §10.8](../../docs/10-安全方案.md)）。
 *
 * ⚠️ **脱敏不给开关** —— 能关就等于允许把身份证明文存库。
 *
 * 打码两个维度：
 * 1. **字段名像密钥**（`api_key` / `token` / `password` …）→ 整个值换成 `***`
 * 2. **值本身像密钥**（`sk-…` / `Bearer …`）→ 就地替换
 */

/** 字段名命中这些词 → 整个值打码 */
const SECRET_KEY_PATTERN =
  /(^|[_-])(api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|auth|credential|private[_-]?key|access[_-]?key|session[_-]?key)($|[_-])/i;

/** 值本身像密钥（**与 `lib/errors.ts` 的规则一致**） */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9._-]{6,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{6,}/gi,
  /((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)["']?[^\s"',}]{6,}["']?/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
];

/** 打码后的占位符 */
export const MASK = '***';

/** 这个字段名是不是密钥类字段 */
export function isSecretField(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

/** 打码一个字符串里的疑似密钥 */
export function maskString(value: string): string {
  let out = sanitizeMessage(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      prefix ? `${prefix}${MASK}` : MASK,
    );
  }
  return out;
}

/**
 * 递归打码一个值（**对象 / 数组 / 字符串**）。
 *
 * ⚠️ **入参出参都要过这一层** —— 工具流水、工具卡片、落库的 parts 都不能带明文密钥。
 */
export function maskValue(value: unknown, depth = 0): unknown {
  // ⚠️ **限深** —— 循环引用的对象会把递归带进死循环
  if (depth > 6) return '[深度超限]';

  if (typeof value === 'string') return maskString(value);
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretField(key) ? MASK : maskValue(item, depth + 1);
  }
  return out;
}

/** 打码后转成 JSON 字符串（**流水与卡片存这个**） */
export function maskToJson(value: unknown): string {
  try {
    return JSON.stringify(maskValue(value)) ?? '';
  } catch {
    return '"[无法序列化]"';
  }
}
