import { tool as makeTool } from '@langchain/core/tools';
import { logger } from '../logger.js';
import { spawnSubagentTool } from '../agent/subagent.js';
import { getSkills } from '../skills/store.js';
import { skillToolGroups } from '../skills/tools.js';
import { fsTools } from './builtin/fs.js';
import { cronToolGroups } from './builtin/cron.js';
import { httpTools } from './builtin/http.js';
import { searchTools } from './builtin/search.js';
import { memoryTools } from './builtin/memory.js';
import { shellTools } from './builtin/shell.js';
import { timeTools } from './builtin/time.js';
import { sandboxToolGroups } from './builtin/code.js';
import { browserToolGroups } from './builtin/browser.js';
import { getMcpManager, mcpToolGroups } from './mcp/manager.js';
import type { ToolDefinition, ToolSource } from './types.js';

/**
 * 统一工具注册表 —— **内置 / Skill / MCP 在模型看来是同一池工具**
 * （见 [12-c C1](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **唯一入口 `tools/registry.ts`** —— 三种来源各自产出一批工具定义，
 * 合并成同一份工具池，交给图的工具节点。
 *
 * ⚠️ **工具名全局唯一** —— 冲突时 Skill / MCP 的工具改名或拒绝注册，
 * 并在启动日志里打印冲突详情。
 * ⚠️ **启动即失败，不要静默覆盖内置工具** —— 两个内置工具重名是代码错误，直接抛。
 */

/** 工具名冲突（**内置之间冲突 = 启动失败**） */
export class ToolConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolConflictError';
  }
}

/** 注册表 */
export interface ToolRegistry {
  /** 全部工具（**已按名字排序，方便看**） */
  list(): ToolDefinition[];
  /** 按名字取一个 */
  get(name: string): ToolDefinition | undefined;
  /** 工具名列表 */
  names(): string[];
}

/** 一组带来源的工具 */
export interface ToolGroup {
  source: ToolSource;
  tools: ToolDefinition[];
}

/**
 * 合并工具组 —— **冲突改名或拒绝注册**。
 *
 * @param groups 按优先级排（**内置在前** —— 内置的名字不许被别人占）
 */
export function mergeToolGroups(groups: ToolGroup[]): ToolDefinition[] {
  const taken = new Map<string, ToolDefinition>();
  const merged: ToolDefinition[] = [];

  for (const group of groups) {
    for (const item of group.tools) {
      const existing = taken.get(item.name);
      if (!existing) {
        taken.set(item.name, item);
        merged.push(item);
        continue;
      }

      // ⚠️ **两个内置撞名 = 代码写错了** —— 直接失败，别偷偷覆盖
      if (existing.source === 'builtin' && item.source === 'builtin') {
        throw new ToolConflictError(
          `内置工具重名：「${item.name}」被定义了两次 —— 工具名必须全局唯一`,
        );
      }

      // ⚠️ **第三方来源撞名 → 改名**（`<来源>__<名字>`），改完还撞就不注册
      const renamed = `${group.source}__${item.name}`;
      if (taken.has(renamed)) {
        logger.warn(
          { tool: item.name, source: group.source },
          '工具名冲突且改名后仍冲突 —— 该工具不注册',
        );
        continue;
      }
      logger.warn(
        { tool: item.name, source: group.source, renamed },
        '工具名冲突 —— 已改名注册',
      );
      const copy: ToolDefinition = { ...item, name: renamed };
      taken.set(renamed, copy);
      merged.push(copy);
    }
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 内置工具组（**只有内置 —— Skill / MCP 还没接**）。
 *
 * ⚠️ **`web_search` 只有配了搜索后端才在池子里** ——
 * 模型看不到一个必然失败的工具（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md) 验收项）。
 */
export function builtinToolGroups(): ToolGroup[] {
  return [
    { source: 'builtin', tools: fsTools },
    { source: 'builtin', tools: shellTools },
    { source: 'builtin', tools: httpTools() },
    // 📌 **联网搜索** —— **始终注册**（默认走免 key 的 DuckDuckGo）
    //    （见 [12-c C2](./docs/12-c-需求-工具技能与扩展.md)）
    ...searchTools(),
    { source: 'builtin', tools: timeTools },
    // 📌 **记忆管理** —— `memory`（查看/新增/改写/归档）·
    //    `memory_forget`（永久删除/清空，**high 档要确认**）
    //    （见 [12-d D4](../docs/12-d-需求-记忆与配置.md)）
    { source: 'builtin', tools: memoryTools },
    // 📌 **定时任务管理** —— `cron`（增删查改，**normal 档**）
    //    （见 [12-b B11](./docs/12-b-需求-对话与编排.md)）
    ...cronToolGroups(),
    // 📌 **子代理派发** —— 也是内置工具（见 [12-b B10](../docs/12-b-需求-对话与编排.md)）
    { source: 'builtin', tools: [spawnSubagentTool] },
    // 📌 **沙箱代码** —— Hermes 的招牌能力（见 [12-c C2](../docs/12-c-需求-工具技能与扩展.md)）
    ...sandboxToolGroups(),
    // 📌 **浏览器** —— 没装 Playwright 就不注册（模型看不到一个必然失败的工具）
    ...browserToolGroups(),
  ];
}

/**
 * 全部工具组 —— **内置 + 技能 + MCP**
 * （见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md) 与 [C5](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **技能工具走同一套权限闸** —— 技能脚本能执行任意代码，
 * 所以默认 `high` 档，**不能绕过确认**。
 * 📌 **MCP 工具默认 `ask`** —— 第三方来源一律要人确认（见 [C3](../docs/12-c-需求-工具技能与扩展.md)）。
 */
export function allToolGroups(): ToolGroup[] {
  return [...builtinToolGroups(), ...skillToolGroups(getSkills()), ...mcpToolGroups()];
}

/** 建一个注册表 */
export function buildRegistry(groups: ToolGroup[] = allToolGroups()): ToolRegistry {
  const tools = mergeToolGroups(groups);
  const byName = new Map(tools.map((item) => [item.name, item]));
  return {
    list: () => tools,
    get: (name: string) => byName.get(name),
    names: () => tools.map((item) => item.name),
  };
}

let cached: ToolRegistry | undefined;

/** 上次建池时的工具池指纹（**技能或 MCP 变了就重建**） */
let cachedFingerprint = '';

/**
 * ⚠️ **手动注入的注册表被「钉住」** ——
 * 注入之后指纹再变也不自动重建（否则刚注入的工具池会被顶掉）。
 */
let pinned = false;

/** 技能集合的指纹 —— **名字 + 脚本数 + 是否启用** */
function skillFingerprint(): string {
  try {
    return getSkills()
      .map((skill) => `${skill.meta.name}:${skill.scripts.length}:${skill.meta.enabled ? 1 : 0}`)
      .join(',');
  } catch {
    // ⚠️ **扫不出技能就让指纹变化** —— 重建时会把真正的错误抛出来
    return 'invalid';
  }
}

/**
 * 工具池指纹 —— **技能变了、MCP 连上了都要重建**。
 *
 * 📌 **MCP 的指纹来自连接状态** —— server 连上 / 断开 / 工具列表变了，
 *    工具池都要跟着变（否则模型看不到新接进来的工具）。
 */
function toolPoolFingerprint(): string {
  let mcp: string;
  try {
    mcp = getMcpManager().fingerprint();
  } catch {
    mcp = 'mcp-error';
  }
  return `${skillFingerprint()}||${mcp}`;
}

/**
 * 全局注册表（**进程内缓存一份**）。
 *
 * ⚠️ **改描述要重启才生效** —— 描述不要缓存到「下一次调用」，
 * 但进程内缓存是允许的（文档要求「改描述立即生效」指的是**下一轮对话**，
 * 而改代码本来就要重启）。
 *
 * 📌 **技能变了会自动重建** —— 新建的技能立刻能拿到它的脚本工具，
 * 不用等重启（技能**说明**的注入仍然是「下一轮对话」生效）。
 */
export function getToolRegistry(): ToolRegistry {
  // ⚠️ **手动注入的注册表不被自动替换** —— 注入者的意图优先于指纹
  if (pinned && cached) return cached;

  const fingerprint = toolPoolFingerprint();
  if (!cached || fingerprint !== cachedFingerprint) {
    cached = buildRegistry();
    cachedFingerprint = fingerprint;
    logger.info(
      { count: cached.list().length, tools: cached.names() },
      '工具池已就绪',
    );
  }
  return cached;
}

/**
 * 测试用：换掉全局注册表。
 *
 * ⚠️ **注入的注册表会被「钉住」** —— 之后指纹再变也不会自动重建，
 * 否则刚注入的假工具池会被真工具池顶掉（测试就白注入了）。
 * 传 `undefined` 解钉。
 */
export function setToolRegistry(registry: ToolRegistry | undefined): void {
  cached = registry;
  pinned = registry !== undefined;
  if (!pinned) cachedFingerprint = '';
}

/**
 * 转成 LangChain 的工具（**给模型绑定用**）。
 *
 * ⚠️ **这里只负责「让模型认识这个工具」** —— 真正的执行走
 * `agent/tool-node.ts` 的统一入口（**不许在图节点里直接 `invoke`**，
 * 否则权限闸被绕过，见 [03-b §B.5.2](../docs/03-b-技术栈-后端栈.md)）。
 */
export function toLangChainTools(definitions: ToolDefinition[]): Array<
  ReturnType<typeof makeTool>
> {
  return definitions.map((definition) =>
    makeTool(
      async (args: unknown) => {
        const result = await definition.invoke(args, {});
        return result.output;
      },
      {
        name: definition.name,
        description: definition.description,
        schema: definition.schema as never,
      },
    ),
  );
}
