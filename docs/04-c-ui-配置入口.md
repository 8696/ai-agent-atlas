# 04-c · UI · 配置入口

> **所有配置在代码 / 配置文件里改** —— 改完重启生效
> （提示词 / 上下文 / 记忆除外，下一轮即生效）。
>
> 本文件记录三件事：
> ① 每项配置**在哪、怎么改、什么时候生效**；
> ② 各项配置的**校验规则**与**提示文案**；
> ③ **命令行工具清单**（改配置、查记忆、查流水、查成本、跑评测、管定时任务）。

---

## 4.1 配置落点总表

| 配置项                   | 落地位置                          | 生效时机 | 备注                             |
| ------------------------ | --------------------------------- | -------- | -------------------------------- |
| AI 模型（Base URL + Key + 模型标识 + 思考预算） | `.env` 的 `LLM_*`        | 重启     | ⚠️ **纯标量**：没有 JSON、没有供应商前缀 |
| 上下文文件（项目指令）   | `AGENTS.md`（项目根）             | **下一轮** | 对标 Hermes 的同名文件         |
| 人格文件                 | `SOUL.md`（项目根）               | **下一轮** | 对标 Hermes 的人格文件         |
| 提示词（system/tool/memory/summary） | `prompts/<name>.md` | **下一轮对话** | 版本与回滚靠 git       |
| 通用配置（20 项 / 6 组 + 4 项新） | `.env`  | 重启     | 超出范围 → **启动即报错**        |
| 内置工具元信息（描述/敏感档/启用） | `tools/builtin/*` + `tools/registry.ts` | 重启 | 描述改了模型选工具的行为就变 |
| Skill                    | `data/skills/<name>/SKILL.md`     | 重启     | 手动拷目录；脚本默认 `high` 敏感档 |
| MCP server               | `data/mcp.json`（文件）         | 重启   | `.env` 只留 `MCP_CONFIG_PATH` 路径；`toolPolicy` 默认 `ask` |
| 长期记忆（Agent 侧）     | `data/memory/MEMORY.md`           | 即时     | 人可直接编辑；FTS5 索引自动重建   |
| 长期记忆（用户侧）       | `data/memory/USER.md`             | 即时     | 同上；也可 `yarn memory:*` 增删改 |
| 定时任务                 | `data/cron.json`                  | 重启     | 自然语言 schedule + 指令         |
| 预算 / 成本闸            | `.env`          | 重启     | 超预算由后端拦截并回话说明原因   |

> ⚠️ **表里的相对路径一律相对「项目根」**（不是当前工作目录）——
> 基准规则见 [02 §路径基准](./02-系统架构与目录.md)。
> 代码里用 `paths.*` 的绝对路径（`src/config/paths.ts`）。
>
> ⚠️ **`.env` 与 `.env.example` 是一份东西的两副面孔**：
> 同一组 key、同一顺序、同一段注释，**只有值不同**。
> `.env` 是实际值（**不进 git** —— 里面有密钥）；
> `.env.example` 是模板（**进 git** —— 改动的历史在这里）。
> ⚠️ **所以「配置有历史」的准确说法是**：
> *模板*的改动进 git，实际值不进 —— 换机器要靠 `.env.example` + 本文档。
> ⚠️ **记忆文件是「可编辑的真源」** —— 它既是数据也是配置，
> 直接用编辑器改就行（改动会在下一轮被重新索引）。

---

## 4.2 模型（`.env` 的 `LLM_*`）

⚠️ **纯标量，三行** —— 一个 Base URL + 一个 Key + 一个模型标识：

```dotenv
LLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
LLM_API_KEY=sk-xxxx
LLM_MODEL=glm-5.3
```

可选：备用模型（**留空 = 没有兜底**）· 思考预算 · 输出上限 · 温度。

⚠️ **换供应商只改这三行，不改代码** —— 四家国产模型全都提供 Anthropic 兼容端点，
所以**只需要一个 `anthropic` 适配器**（`@langchain/anthropic`）。

**已实测可用的端点**（五项能力全绿：对话 / 思考 / 工具调用 / 流式 / tool_result 回灌）：

| 供应商    | `LLM_BASE_URL`                                  | `LLM_MODEL`       |
| --------- | ----------------------------------------------- | ----------------- |
| 智谱 GLM  | `https://open.bigmodel.cn/api/anthropic`         | `glm-5.3`         |
| MiniMax   | `https://api.minimaxi.com/anthropic`             | `MiniMax-M3`      |
| DeepSeek  | `https://api.deepseek.com/anthropic`             | `deepseek-v4-pro` |
| 千问 Qwen  | `https://dashscope.aliyuncs.com/apps/anthropic`  | `qwen3.8-max`    |

⚠️ MiniMax 直连不稳定（DNS 解析到保留段），需要走代理。

降级成「代码里的校验 / 提示」的点：

- ⚠️ **`LLM_BASE_URL` 的 SSRF 校验**：禁止指向云元数据地址；
  **本地端点是例外**（回环地址是用户自己的机器）——
  **启动时校验一次，每次调用前再校验一次**
- ⚠️ **API Key 只在启动时从 `.env` 读进内存**：不落库、不写日志、不在任何接口里回显
- ⚠️ **没配模型时的空状态**：后端返回 503 + 「还没配置模型」，
  前端显示一句提示 + **指明改 `.env` 的 `LLM_MODEL`**（静态文案，不走后端取配置）
- **备用模型切换**：仅在「一个内容 chunk 都没吐出去」时切（见 [12-a A3](./12-a-需求-应用外壳与上下文.md)）
- ⚠️ **`max_tokens` 必须 > 思考预算** —— Anthropic 硬要求，
  建模型时抬到 `max(预算 + 1024, LLM_MAX_TOKENS)`

---

## 4.3 上下文文件与提示词

| 文件                      | 作用                 | 生效时机   |
| ------------------------- | -------------------- | ---------- |
| `AGENTS.md`（项目根）     | 项目级指令           | **下一轮** |
| `SOUL.md`（项目根）       | 人格 / 语气 / 风格   | **下一轮** |
| `prompts/system.md`  | 系统提示词           | **下一轮** |
| `prompts/tool.md`    | 工具使用规范         | **下一轮** |
| `prompts/memory.md`  | 记忆抽取 / 召回指令  | **下一轮** |
| `prompts/summary.md` | 摘要指令             | **下一轮** |

- 提示词文件名 ∈ `system` / `tool` / `memory` / `summary`
- ⚠️ **没有版本表、没有发布指针** —— 文件当前内容就是生效内容，
  **版本与回滚 = git**（`git checkout` 回上一版即回滚）
- 每轮对话**读文件**（不缓存到进程）→ 改完**下一轮立即生效，不用重启**
- 占位符：`{{tools}}` `{{memories}}` `{{skills}}` `{{date}}`
  ⚠️ **未识别的占位符原样保留**（不要清空）
- **文件缺失** → **启动时**从 `src/prompts/defaults.ts` 的兜底模板**写回文件**，
  并在响应里标注「用了兜底提示词」
  （⚠️ 不是运行时悄悄用默认值 —— 文件始终存在，每轮读的都是文件）
- `AGENTS.md` / `SOUL.md` 是**给 Agent 看的项目上下文**（跟项目一起进 git），
  `prompts/` 是**运行时可调的应用提示词** —— 两者作用不同，别混用

---

## 4.3.1 长期记忆文件（`data/memory/*.md`）

- `MEMORY.md` —— Agent 侧记忆（环境事实、做过什么、踩过的坑）
- `USER.md` —— 用户侧记忆（偏好、身份、习惯）
- 每个 `##` 小节 = 一条记忆（frontmatter + 一句话正文）
- ⚠️ **人可直接编辑** —— 改完下一轮重新索引即生效
- 归档 = 条目标 `status: archived`；永久删除 = 从文件里移除
- 检索走 FTS5（见 [12-d D3](./12-d-需求-记忆与配置.md)），**不依赖 embedding 模型**

---

## 4.4 通用配置（`.env`）

六个分组、共 20 项：

| 分组     | 配置项                                                                              |
| -------- | ----------------------------------------------------------------------------------- |
| 通用     | `SYSTEM_LANGUAGE` · `TIMEZONE` · `MAX_TOOL_STEPS` · `TOOL_TIMEOUT_MS` · `WORKSPACE_ROOT` |
| 模型     | `DEFAULT_TEMPERATURE` · `DEFAULT_MAX_TOKENS` · `THINKING_BUDGET` · `MULTI_TOOL_CALLS`    |
| 记忆     | `MEMORY_ENABLED` · `MEMORY_RELEVANCE_ENABLED` · `MEMORY_TOP_K` · `MEMORY_TOKEN_BUDGET` · `SUMMARY_ENABLED` · `SUMMARY_TOKEN_BUDGET` |
| 成本     | `MONTHLY_TOKEN_BUDGET` · `COST_BUDGET_BLOCK` · `WARN_RATIO`                            |
| 安全     | `ALLOW_PRIVATE_EGRESS` · `SHELL_ENABLED` · `TOOL_CONFIRM_LEVEL`                        |
| 工具     | `TOOL_OUTPUT_MAX_CHARS` · `TOOL_OUTPUT_TRUNCATE`                                       |

校验规则与提示文案：

- ⚠️ **数值范围校验在启动时做**：超出范围 → **启动直接失败**，并指出哪个字段
  （不再有「保存被拒（400）」这种运行时路径 —— 没有保存动作）
- ⚠️ **boolean 项没有「清除覆盖」** —— 没有界面就没有覆盖态，
  直接写 `true` / `false` 即可（默认值即代码里的值）
- ⚠️ **改配置需要重启**（已知代价，文档写明，不做热加载）
- ⚠️ **敏感项（密钥、SSRF 开关、预算硬闸）不出现在任何接口响应里**

---

## 4.5 工具

- 内置工具的**名称 / 描述 / 入参 schema / 敏感档 / 启用开关**写在
  `tools/builtin/*` 与 `tools/registry.ts` 里
- ⚠️ **改描述立即生效**（下一轮就能看出模型调不调它）—— 改代码重启即生效
- ⚠️ **工具名全局唯一**：冲突 → **启动即失败**并打印冲突详情
  （工具名 + 双方来源），不静默覆盖内置工具

---

## 4.6 Skill

- **安装 = 手动把目录拷进 `data/skills/<name>/`**；**卸载 = 删掉目录**
- `SKILL.md` frontmatter：`name` · `description`（触发条件，给模型看）·
  可选 `version` · `enabled`（默认 true）· `sensitivity`（脚本敏感档，默认 `high`）
- ⚠️ **安装前的提醒从「弹窗」改成「终端打印一行」**：
  「技能包里的脚本可以在本机执行任意代码」
- Skill 名冲突 → 启动即失败并报告

---

## 4.7 MCP（`data/mcp.json`）

```json
{
  "servers": [
    {
      "name": "example",
      "transport": "stdio",              // stdio | sse | http
      "command": "npx",
      "args": ["-y", "@example/mcp"],
      "env": {},
      "enabled": true,
      "toolPolicy": "ask"                // ask（默认）| auto | off
    }
  ]
}
```

- ⚠️ **「MCP 工具默认每次确认」这件事没有 UI 可以提示** ——
  改成**启动日志里明确打印一行**：「MCP 工具默认 ask，每次调用都需要确认」
- 连接状态（`connected` / `error` + 原因）→ **启动日志 / 运行日志**

---

## 4.8 命令行工具清单

> 配置、记忆、流水、成本、历史、评测、定时任务 —— **都在命令行里做**。

| 命令                                          | 作用                             |
| --------------------------------------------- | -------------------------------- |
| `yarn memory:list`                            | 列出记忆                       |
| `yarn memory:add --content "<>"`              | 手动新增                       |
| `yarn memory:edit <id>`                       | 编辑记忆                       |
| `yarn memory:archive <id>`                    | 归档（软删）                   |
| `yarn memory:delete <id>`                     | 永久删除                       |
| `yarn memory:clear`                           | 永久清空全部                   |
| `yarn tool:logs [--tool <n>] [--status <s>]`  | 查工具调用流水                 |
| `yarn search:<关键词>`                         | 跨会话 + 记忆全文检索          |
| `yarn cron:list`                              | 列出定时任务与上次执行时间      |
| `yarn cron:add --prompt "<>" --schedule "<>"` | 新增定时任务                    |
| `yarn cron:remove <name>`                     | 删除定时任务                    |
| `yarn skill:list`                             | 列出已装技能                    |

---

## 4.9 后续补充点

- [ ] 各配置项的具体默认值
- [ ] 命令行工具的输出格式（表格 vs JSON，便于脚本消费）
- [ ] 危险操作（删模型、删 Skill、永久删记忆）的统一提示文案
