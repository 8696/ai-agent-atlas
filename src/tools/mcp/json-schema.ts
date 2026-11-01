import { z } from 'zod';
import { MAX_ARRAY, MAX_STRING } from '../args.js';

/**
 * JSON Schema → zod —— **MCP 工具的入参 schema 是 JSON Schema**
 * （见 [12-c C5](./docs/12-c-需求-工具技能与扩展.md)）。
 *
 * ⚠️ **只做结构映射，不做语义推导** ——
 * 第三方 server 写的是「这个字段是字符串」，我们就映射成字符串，
 * 不去猜「这个字段其实是路径」之类的东西。
 *
 * 📌 **不认识的结构一律放宽** —— 宁可放行也不要让模型调不动。
 * MCP server 的 schema 千奇百怪，转不出来时用 `z.unknown()`，
 * **绝不因为一个字段不认识就让整个工具消失**。
 */

/** 一段 JSON Schema */
export type JsonSchema = Record<string, unknown>;

/** 读一个字符串字段 */
function str(node: JsonSchema, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 读一个数组字段 */
function arr(node: JsonSchema, key: string): unknown[] | undefined {
  const value = node[key];
  return Array.isArray(value) ? value : undefined;
}

/** 枚举值（**只认字符串**） */
function stringEnum(node: JsonSchema): string[] | undefined {
  const values = arr(node, 'enum');
  if (!values || values.length === 0) return undefined;
  if (!values.every((item) => typeof item === 'string')) return undefined;
  return values.filter((item): item is string => typeof item === 'string');
}

/**
 * 一个 JSON Schema 节点 → 一个 zod schema。
 *
 * @param depth 递归深度（**防恶意 server 造出自引用结构**）
 */
export function jsonSchemaToZod(node: unknown, depth = 0): z.ZodType {
  // ⚠️ **深度上限** —— 第三方内容不可信，深递归会把自己绕死
  if (depth > 12) return z.unknown();
  if (!node || typeof node !== 'object' || Array.isArray(node)) return z.unknown();

  const schema = node as JsonSchema;
  const description = str(schema, 'description');

  // ── 枚举优先 ──
  const enumValues = stringEnum(schema);
  let result: z.ZodType;
  if (enumValues && enumValues.length > 0) {
    result =
      enumValues.length === 1
        ? z.literal(enumValues[0] as string)
        : z.enum(enumValues as [string, ...string[]]);
  } else {
    const type = str(schema, 'type');
    switch (type) {
      case 'object': {
        const properties = (schema['properties'] ?? {}) as JsonSchema;
        const required = new Set(
          (arr(schema, 'required') ?? []).filter((item): item is string => typeof item === 'string'),
        );
        const shape: Record<string, z.ZodType> = {};
        for (const [key, value] of Object.entries(properties)) {
          const field = jsonSchemaToZod(value, depth + 1);
          shape[key] = required.has(key) ? field : field.optional();
        }
        // 📌 **字段数也有上限** —— 第三方 server 可能给一个 500 字段的 schema
        result = z.object(shape).refine(
          (value) => Object.keys(value).length <= MAX_ARRAY,
          { message: `字段太多（上限 ${MAX_ARRAY} 个）` },
        );
        break;
      }
      case 'array': {
        const items = schema['items'];
        // ⚠️ **数组长度有上限** —— 与内置工具同一套口径
        result = z.array(jsonSchemaToZod(items, depth + 1)).max(MAX_ARRAY);
        break;
      }
      case 'string':
        // ⚠️ **字符串长度有上限** —— 与内置工具同一套口径
        result = z.string().max(MAX_STRING);
        break;
      case 'number':
        result = z.number();
        break;
      case 'integer':
        result = z.number().int();
        break;
      case 'boolean':
        result = z.boolean();
        break;
      case 'null':
        result = z.null();
        break;
      default:
        // ⚠️ **没有 type 也没有 enum** —— 有些 server 写的是 `oneOf` / `anyOf`
        //    直接放宽，别猜
        result = z.unknown();
    }
  }

  // 📌 **默认值** —— 有就填上，模型少传一个参数时也能过
  const defaultValue = schema['default'];
  if (defaultValue !== undefined && result instanceof z.ZodType) {
    try {
      result = result.default(defaultValue as never);
    } catch {
      // 默认值类型对不上就忽略它 —— 不影响工具可用性
    }
  }

  return description ? result.describe(description) : result;
}

/**
 * MCP 工具的入参 schema → zod。
 *
 * ⚠️ **顶层不是 object 时包一层** —— 工具入参必须是对象
 * （模型发的是 `{参数名: 值}`），否则调用一定失败。
 */
export function toolInputSchema(inputSchema: unknown): z.ZodType {
  const schema = jsonSchemaToZod(inputSchema);
  if (schema instanceof z.ZodObject) return schema;
  // ⚠️ **不是 object 就放宽成 object** —— 别让工具整个不可用
  return z.object({}).passthrough();
}

/** 描述有没有可疑内容（**第三方描述是不可信数据**） */
export function hasSuspiciousDescription(description: string | undefined): boolean {
  if (!description) return false;
  const text = description.toLowerCase();
  const patterns = [
    'ignore previous',
    'ignore all previous',
    '忽略之前',
    '忽略以上',
    'ignore the above',
    'disregard',
    'system prompt',
  ];
  return patterns.some((pattern) => text.includes(pattern));
}
