import { config, type Env } from '../../config.js';
import { SENSITIVITY_RANK, type ToolDefinition, type ToolSensitivity } from '../../tools/types.js';
import { matchBlacklist } from './blacklist.js';
import { tightenSensitivity, type InjectionScan } from './injection.js';

/**
 * 工具权限与危险策略 —— **四档判定**（见 [12-c C3](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * | 判定     | 含义                                   |
 * | -------- | -------------------------------------- |
 * | `allow`  | 直接执行                               |
 * | `await`  | 挂起等确认（人工确认闸，见 [12-b B5](../docs/12-b-需求-对话与编排.md)） |
 * | `blocked`| 禁止（**工具不执行**，原因回灌给模型） |
 * | `reject` | 拒绝并回灌                             |
 *
 * **策略来源（按优先级）**：
 * 1. **硬禁**（`SHELL_ENABLED=false` → `blocked`）
 * 2. **命令黑名单**（命中 → `blocked`，**不给确认的机会**）
 * 3. **MCP server 粒度策略**（`data/mcp.json` 的 `toolPolicy`：`ask` / `auto` / `off`）
 * 4. **工具敏感档**（`high` → `await`）
 * 5. **全局档位**（`TOOL_CONFIRM_LEVEL`：`none` / `normal` / `high`）
 */

export type ToolDecision = 'allow' | 'await' | 'blocked' | 'reject';

/** 判定结果 */
export interface PolicyDecision {
  decision: ToolDecision;
  /** 原因（**回灌给模型 / 显示给用户**） */
  reason: string;
}

/** MCP server 粒度策略（**第三方来源一律当高危**） */
export type McpToolPolicy = 'ask' | 'auto' | 'off';

/** 确认档位（**低于这个档的工具不弹确认**） */
export type ConfirmLevel = 'none' | 'normal' | 'high';

const CONFIRM_RANK: Record<ConfirmLevel, number> = { none: 0, normal: 1, high: 2 };

/** MCP server 的策略（**从 `data/mcp.json` 读；本期还没接 MCP，留好口子**） */
export type McpPolicyLookup = (toolName: string) => McpToolPolicy | undefined;

/**
 * 被硬禁的工具（**一键开关关掉的整块能力**）。
 *
 * ⚠️ **`SHELL_ENABLED=false` → `shell` 直接不可用** ——
 * 不是「还要确认」，是**根本不注册给模型**。
 */
export function disabledTools(env: Env = config): Set<string> {
  const disabled = new Set<string>();
  if (!env.SHELL_ENABLED) disabled.add('shell');
  return disabled;
}

/**
 * 这个工具要不要人确认。
 *
 * ⚠️ **`TOOL_CONFIRM_LEVEL` 是「门槛」而不是「白名单」**：
 * 设成 `high`（默认）→ 只有 `high` 档工具要确认；
 * 设成 `normal` → `normal` 与 `high` 都要确认；
 * 设成 `none` → **都不确认**（这是用户的主动选择，不是默认）。
 */
export function needsConfirmation(
  sensitivity: ToolSensitivity,
  env: Env = config,
): boolean {
  const level: ConfirmLevel = env.TOOL_CONFIRM_LEVEL;
  if (level === 'none') return false;
  return SENSITIVITY_RANK[sensitivity] >= CONFIRM_RANK[level];
}

/**
 * 这个工具的入参里有没有「命令」—— 有的话要在策略层过黑名单。
 *
 * ⚠️ **只认 `shell`** —— 其他工具的命令语义各不相同
 * （`execute_code` 的 `code` 是 JS，技能脚本的内容根本不在入参里），
 * 拿同一条正则去扫它们只会误伤。
 */
function commandOf(toolName: string, args: unknown): string | undefined {
  if (toolName !== 'shell') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

/** 判断一个工具该怎么走 */
export function decideTool(
  tool: Pick<ToolDefinition, 'name' | 'sensitivity' | 'source'>,
  options: {
    env?: Env;
    /** 硬禁名单（**如 `shell` 被 `SHELL_ENABLED=false` 关掉**） */
    disabled?: ReadonlySet<string>;
    /** MCP server 粒度策略 */
    mcpPolicy?: McpPolicyLookup;
    /** 工具入参（**命令黑名单要看它**） */
    args?: unknown;
    /**
     * 注入检测结果（**命中就把工具档位收紧**）。
     *
     * ⚠️ **收紧必须在这一层生效** —— 只收紧「给模型看的那份副本」是空的
     *    （见 [10 §10.7](../../docs/10-安全方案.md)）。
     */
    injection?: InjectionScan | undefined;
  } = {},
): PolicyDecision {
  const env = options.env ?? config;
  const disabled = options.disabled ?? new Set<string>();

  // ── 1. 硬禁 ──
  if (disabled.has(tool.name)) {
    return { decision: 'blocked', reason: `工具「${tool.name}」已被全局开关禁用` };
  }

  // ── 2. 命令黑名单 ──
  // 📌 **在策略层判，不在工具内部判** —— 内部判的话用户会先看到确认卡片，
  //    批准之后才被告知「其实不让跑」（见 [12-c C3](../docs/12-c-需求-工具技能与扩展.md)）
  const command = commandOf(tool.name, options.args);
  if (command !== undefined) {
    const hit = matchBlacklist(command);
    if (hit) {
      return {
        decision: 'blocked',
        reason: `命令命中安全黑名单（${hit.name}：${hit.reason}）`,
      };
    }
  }

  // ── 3. MCP server 粒度策略 ──
  const mcpPolicy = options.mcpPolicy?.(tool.name);
  if (mcpPolicy === 'off') {
    return { decision: 'blocked', reason: `工具「${tool.name}」已被 MCP 配置禁用` };
  }
  if (mcpPolicy === 'auto') {
    return { decision: 'allow', reason: 'MCP 配置为自动放行' };
  }
  if (mcpPolicy === 'ask') {
    return { decision: 'await', reason: 'MCP 工具默认需要确认' };
  }

  // ── 4 + 5. 敏感档 vs 全局确认档 ──
  // ⚠️ **注入命中 → 收紧档位**（`low` / `normal` 提到 `high`）
  const sensitivity = options.injection?.detected
    ? tightenSensitivity(tool, options.injection).sensitivity
    : tool.sensitivity;

  if (needsConfirmation(sensitivity, env)) {
    return {
      decision: 'await',
      reason:
        sensitivity === 'high'
          ? '高危操作，执行前需要确认'
          : '该操作执行前需要确认',
    };
  }

  return { decision: 'allow', reason: '低风险，直接执行' };
}
