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
  // 📌 **`id.secret` 形态** —— 智谱这类平台的 key 没有 `sk-` 前缀
  //    （实测本项目在用的是 `32位hex.16位base62`）
  //    ⚠️ **第一段必须是十六进制** —— 免得误伤 JWT（`xxx.yyy.zzz`）
  /\b[0-9a-fA-F]{24,}\.[A-Za-z0-9]{16,}\b/g,
];

/**
 * 配置里的密钥字段（**登记精确值用**）。
 *
 * ⚠️ **跟 `SECRET_KEY_PATTERN` 不是一回事** —— 那个是「字段名像密钥」，
 *    拿来决定「整个值要不要打码」；这个只认**真的装密钥的字段**。
 *    （`MONTHLY_TOKEN_BUDGET` 里也有 token，但它不是密钥。）
 */
const CONFIG_SECRET_PATTERN =
  /(^|_)(API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i;

/**
 * 已知密钥的**精确值**（**长度 ≥ 8 才算** —— 太短的值容易误伤正文）。
 *
 * ⚠️ **正则只是常见形态的兜底** —— 供应商的 key 形态千奇百怪，
 *    正则认不出的就靠这张表（**启动时按配置里的真值登记**）。
 */
const knownSecrets = new Set<string>();

/**
 * 注册一个确切的密钥值 —— 打码时按**精确值**替换。
 *
 * 📌 **为什么不能只靠正则** —— 本项目在用的智谱 key 是
 *    `32位hex.16位base62`，`sk-` / `Bearer` / `AKIA` 一条都不匹配。
 * 正则只是**常见形态的兜底**，**精确值才是可靠的**。
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  knownSecrets.add(trimmed);
}

/**
 * 重新扫一遍 `process.env`（**测试用**）。
 *
 * ⚠️ **正常代码不该调它** —— 扫描是一次性的（懒加载）。
 */
export function resetSecretScan(): void {
  envScanned = false;
}

/** 这个配置项是不是「装着密钥的那种」（**给启动时登记用**） */
export function isConfigSecretField(name: string): boolean {
  return CONFIG_SECRET_PATTERN.test(name);
}

/** 已登记的密钥值（**测试用**） */
export function registeredSecrets(): string[] {
  return [...knownSecrets];
}

/** `process.env` 扫过了没 */
let envScanned = false;

/**
 * **懒加载**地把 `process.env` 里的密钥字段捞出来登记。
 *
 * ⚠️ **为什么要懒加载** —— `registerSecret()` 在 `config.ts` 加载时调用，
 *    但 `mask.ts` 本身**不依赖 config**（脚本与单测都能单独 import 它）。
 *    哪条路径先打码、config 有没有被加载过，**不该影响脱敏是否生效** ——
 *    这道防线不能有「取决于加载顺序」的漏洞。
 */
function ensureEnvSecrets(): void {
  if (envScanned) return;
  envScanned = true;
  for (const [key, value] of Object.entries(process.env)) {
    if (isConfigSecretField(key)) registerSecret(value);
  }
}

/** 打码后的占位符 */
export const MASK = '***';

/** 这个字段名是不是密钥类字段 */
export function isSecretField(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

/** 打码一个字符串里的疑似密钥 */
export function maskString(value: string): string {
  ensureEnvSecrets();
  let out = sanitizeMessage(value);
  // 📌 **先按精确值替换** —— 正则认不出的形态（智谱的 `id.secret`）靠这一步
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (prefix ? `${prefix}${MASK}` : MASK));
  }
  return out;
}

/**
 * 这个字符串里有没有**疑似密钥**（**只检测，不打码**）。
 *
 * 📌 **给「写入前扫描」用** —— 记忆 / 技能这类持久化内容里
 * 不该出现 API Key（见 [12-e E4](../docs/12-e-需求-观测安全与验收.md)）。
 *
 * ⚠️ **重新编译正则** —— `SECRET_VALUE_PATTERNS` 带 `g` 标志，
 * 直接 `.test()` 会因为 `lastIndex` 而时灵时不灵。
 */
export function looksLikeSecret(value: string): boolean {
  if (typeof value !== 'string' || value === '') return false;
  ensureEnvSecrets();
  // 📌 **已登记的精确值也算** —— 供应商的形态再怪，登记过就认得
  for (const secret of knownSecrets) {
    if (value.includes(secret)) return true;
  }
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    return probe.test(value);
  });
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

  // ⚠️ **Error 要单独处理** —— `message` / `stack` 是**不可枚举属性**，
  //    直接递归会把错误信息整个抹掉（变成 `{}`）
  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskString(value.message),
      ...(value.stack ? { stack: maskString(value.stack) } : {}),
    };
  }

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
