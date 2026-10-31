# 05-a · 数据模型 · SQLite

> 单库单文件：`data/atlas.db`。
> 全部表带 `created_at` / `updated_at`（UTC 墙钟，见 §5.3）。
> 本项目**没有 `tenant_id`** —— 单用户本地，不做租户隔离（见 [01 §1.2](./01-需求与场景.md)）。

## 5.1 核心表

> ⚠️ **本项目没有 `tenant_id`，也没有 `user_id`** ——
> 本地单用户、无鉴权（见 [12-a A1](./12-a-需求-应用外壳与上下文.md)），
> 所有表都是单用户语义，**不需要行级归属过滤**。

> ⚠️ **所有路径相对「项目根」**（不是 cwd）——
> `DATABASE_PATH` 的默认值 `data/atlas.db` 经 `resolvePath()` 解析成绝对路径，
> 由 `paths.databaseFile` 提供（见 [02 §路径基准](./02-系统架构与目录.md)）。
> ⚠️ **相对 cwd 会导致「在错误位置建一个新库」** —— 看着能跑，数据全空。

### 会话表（`sessions`）

| 字段             | 类型     | 说明                                                       |
| ---------------- | -------- | ---------------------------------------------------------- |
| `id`             | TEXT PK  | nanoid                                                     |
| `title`          | TEXT     | 首条用户消息截断生成；可手动改                             |
| `status`         | TEXT     | `active` / `archived`                                      |
| `favorite`       | INTEGER  | 0/1                                                        |
| `summary`        | TEXT     | 长对话摘要（TEXT 存 JSON）                                 |
| `metadata`       | TEXT     | JSON：`summary_boundary` / `pending_confirm` 等            |
| `thread_id`      | TEXT     | **LangGraph `thread_id`**（= 会话 id，冗余存一份便于排查） |
| `message_count`  | INTEGER  | 冗余计数，避免列表页 COUNT                                 |
| `last_active_at` | DATETIME | 列表排序用                                                 |
| `created_at`     | DATETIME |                                                            |
| `updated_at`     | DATETIME |                                                            |

索引：`idx_sessions_last (last_active_at DESC)`、`idx_sessions_favorite (favorite)`。

### 消息表（`messages`）

| 字段           | 类型     | 说明                                                      |
| -------------- | -------- | --------------------------------------------------------- |
| `id`           | TEXT PK  | nanoid                                                    |
| `session_id`   | TEXT     | 外键 → `sessions.id`                                      |
| `role`         | TEXT     | `user` / `assistant` / `system` / `tool`                  |
| `content`      | TEXT     | 纯文本正文（Markdown 源）                                 |
| `parts`        | TEXT     | **JSON 数组**：结构化 part（含工具调用卡片、待确认卡片）  |
| `tool_calls`   | TEXT     | JSON：assistant 消息发起的工具调用（ToolCallSchema 数组） |
| `tool_results` | TEXT     | JSON：工具执行结果                                        |
| `attachments`  | TEXT     | JSON：附件引用                                            |
| `favorite`     | INTEGER  | 0/1（消息级收藏）                                         |
| `metadata`     | TEXT     | JSON：`created_at` / `model` / `usage` / `stop_reason` 等 |
| `created_at`   | DATETIME |                                                           |
| `updated_at`   | DATETIME |                                                           |

索引：`idx_messages_session (session_id, created_at)`、`idx_messages_favorite (favorite)`。

> ⚠️ **`messages` 没有自增序号列** —— 排序靠 `created_at`。
> 所以 `utcNow()` 是**进程内单调递增**的（同一毫秒里多次调用各差 1 毫秒），
> 否则同一毫秒插入的多条消息排序会不稳（见 [§5.3](#53-时间与时区约定-)）。

> ⚠️ **`parts` 是「刷新后卡片还在」的依据**：前端渲染工具卡片读的是落库的 `parts`，
> 不是重新拉一次执行记录。改 part 结构要同时改前端渲染分支。

### 配置不在库里 ⚠️

> **本期没有配置界面**，配置一律在**代码 / 配置文件**里改，
> 所以库里**只有运行时产生的数据**。
>
> | 配置什么   | 放在哪                                                           |
> | ---------- | ---------------------------------------------------------------- |
> | 模型       | `.env` 的 `LLM_*`（纯标量：一个 Base URL + Key + 模型）          |
> | 提示词     | `prompts/<name>.md`（文件；版本与回滚靠 git）                    |
> | 通用配置   | `.env`（散成一个个 key）                                         |
> | 工具元信息 | `tools/builtin/*` + `tools/registry.ts` + `SKILL.md` frontmatter |
> | MCP server | `data/mcp.json`（文件；`.env` 里只留 `MCP_CONFIG_PATH`）         |
> | 长期记忆   | `data/memory/MEMORY.md` + `data/memory/USER.md`                  |
> | 定时任务   | `data/cron.json`（有运行时状态 `lastRunAt`，不能放 .env）        |
>
> ⚠️ **配置改完要重启**（提示词 / 上下文 / 记忆除外，下一轮即生效）——
> 这是「配置在文件里」的既定代价，不要偷偷做热加载。
>
> ⚠️ **模型 API Key 只在 `.env`** —— 启动时读进内存即可，
> 不落库、不写日志、不在任何接口里回显（见 §5.4）。
>
> **库里的表**：`sessions` · `messages` · `tool_call_logs` ·
> `messages_fts` / `memory_fts`（FTS5 虚表）· `graph_checkpoints` ·
> `cost_logs` · `audit_logs`。

### 工具调用流水（`tool_call_logs`）

| 字段                    | 类型     | 说明                                                                 |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `id`                    | TEXT PK  |                                                                      |
| `session_id`            | TEXT     |                                                                      |
| `message_id`            | TEXT     | 发起的 assistant 消息                                                |
| `tool_name`             | TEXT     |                                                                      |
| `source`                | TEXT     | `builtin` / `skill` / `mcp`                                          |
| `status`                | TEXT     | `pending` / `running` / `success` / `error` / `rejected` / `timeout` |
| `input`                 | TEXT     | JSON：入参                                                           |
| `output`                | TEXT     | JSON：出参（截断后）                                                 |
| `error`                 | TEXT     | 错误信息                                                             |
| `duration_ms`           | INTEGER  |                                                                      |
| `requires_confirmation` | INTEGER  | 0/1                                                                  |
| `created_at`            | DATETIME |                                                                      |

索引：`idx_tool_logs_session (session_id, created_at)`、`idx_tool_logs_tool (tool_name, created_at)`。

### 长期记忆（Markdown 文件 + FTS5 索引）

> 记忆的真源是 **`data/memory/MEMORY.md`** 与 **`data/memory/USER.md`**
> （对齐 Hermes 的 `MEMORY.md` / `USER.md`，见 [12-d D2](./12-d-需求-记忆与配置.md)）。
> 库里只有它的 FTS5 索引（`memory_fts`），没有记忆本体表 —— 理由：
>
> - 人能直接读、直接改、直接 `git diff`（这是选文件而不是选表的核心原因）
> - 不需要 embedding 列，也就不需要 embedding 模型
>   → **少一个依赖、少一个故障点**
> - 单用户量级小（≤ 50 条自动记忆 + 手写几条），全文检索足够
>
> ⚠️ **代价**：Markdown 没有事务 → 写入必须是「重读 → 合并 → 原子写
> （临时文件 + `rename`）」，见 [12-d D2](./12-d-需求-记忆与配置.md)。
>
> ⚠️ **条目元信息写在 frontmatter 里**（`kind` / `confidence` / `source` /
> `status` / `updated`），正文一句话 —— 结构化到能被程序增删改。

### 全文检索表（FTS5）

> 跨会话检索（[12-d D3](./12-d-需求-记忆与配置.md)）靠 SQLite FTS5，
> 不靠向量。两个虚表：

| 虚表           | 索引什么                                     | 同步方式                                 |
| -------------- | -------------------------------------------- | ---------------------------------------- |
| `messages_fts` | 会话消息正文（`messages.content`）           | 写消息时同步 insert                      |
| `memory_fts`   | 记忆条目（从 `data/memory/*.md` 解析进来的） | 记忆文件变更时重建（量小，全量重建即可） |

- ⚠️ **分词器用 `tokenize='trigram'`**（SQLite ≥ 3.34）：
  默认的 `unicode61` **不切中文** —— 一整句中文会被当成一个 token，
  搜「跑一下测试」搜不到「我今天跑了一下单元测试」
- ⚠️ **trigram 的代价**：查询词 **≥ 3 字符**；英文按 3 字符滑窗匹配（能用但慢）
- ⚠️ **启动时探测可用性**（`pragma_compile_options()` 里查 `ENABLE_FTS5`）——
  不可用就**退回「时间倒序取最近 N 条」**，功能少一半但**不影响对话**
- 索引表只存文本，**不存向量**

### 图检查点表（`graph_checkpoints`）

> LangGraph checkpointer 的落盘表。**由 LangGraph 的 SQLite saver 管理**，
> 不手写迁移；这里只登记它的存在，升级 LangGraph 时按它的文档走。

| 字段                   | 类型      | 说明                                 |
| ---------------------- | --------- | ------------------------------------ |
| `thread_id`            | TEXT      | 会话 id                              |
| `checkpoint_ns`        | TEXT      | 命名空间                             |
| `checkpoint_id`        | TEXT      |                                      |
| `parent_checkpoint_id` | TEXT      | 父检查点                             |
| `type`                 | TEXT      | `checkpoint` / `metadata` / `writes` |
| `data`                 | TEXT/BLOB | 序列化后的状态                       |
| `created_at`           | DATETIME  |                                      |

索引：`idx_gc_thread (thread_id, checkpoint_id)`。

> ⚠️ **这张表是「进程重启后能续跑」的唯一保障**。
> 用进程内的 MemorySaver = 重启后对话状态全丢（会话记录还在，但工具调用链断了）。

### 成本流水表（`cost_logs`）

> **只用来算钱和控制预算**，不做分析报表。

| 字段                | 类型     | 说明                                                |
| ------------------- | -------- | --------------------------------------------------- |
| `id`                | TEXT PK  |                                                     |
| `session_id`        | TEXT     |                                                     |
| `provider`          | TEXT     |                                                     |
| `model`             | TEXT     |                                                     |
| `usage_scope`       | TEXT     | `chat` / `memory` / `summary` / `subagent` / `cron` |
| `prompt_tokens`     | INTEGER  |                                                     |
| `completion_tokens` | INTEGER  |                                                     |
| `reasoning_tokens`  | INTEGER  | ⚠️ 推理模型的思考 token **全额算输出**              |
| `cached_tokens`     | INTEGER  |                                                     |
| `cost`              | REAL     | 按当时价格算出来的钱                                |
| `created_at`        | DATETIME |                                                     |

索引：`idx_cost_logs_session (session_id, created_at)`、`idx_cost_logs_created (created_at)`。

> ⚠️ **这张表是预算闸的地基** —— 月度预算判断、硬拦都靠它
> （见 [12-d D4](./12-d-需求-记忆与配置.md)）。
> 删了它就没有「花了多少」的概念，也设不了上限。
> ⚠️ **没有成本分析报表** —— 本地单用户靠 provider 侧的账单就够了。

### 操作审计表（`audit_logs`）

> 本地也要有：改了模型配置、装了 Skill、接了 MCP server、删了记忆 —— 这些都留痕。
> ⚠️ **绝不记密钥明文**（`api_key` 一律打码）。

| 字段          | 类型     | 说明                                                                   |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `id`          | TEXT PK  |                                                                        |
| `action`      | TEXT     | `MODEL_CREATED` / `SKILL_INSTALLED` / `MCP_ADDED` / `MEMORY_DELETED` … |
| `target_type` | TEXT     |                                                                        |
| `target_id`   | TEXT     |                                                                        |
| `details`     | TEXT     | JSON（脱敏后）                                                         |
| `created_at`  | DATETIME |                                                                        |

## 5.2 表关系

```
users 1───n sessions 1───n messages
              │  │
              │  └──1 graph_checkpoints (thread_id = session_id)
              │
              ├──n messages
              ├──n tool_call_logs
              ├──n cost_logs
              └──n messages_fts / memory_fts（FTS5 虚表，非关系表）

audit_logs
evaluation_*
```

> ⚠️ **库里没有配置表，也没有账号表** ——
> 配置在代码 / 配置文件里（见 §5.1「配置不在库里」），本期无鉴权、单用户。
>
> ⚠️ **模型不用装饰器**（`src/models/*.model.ts` 的列定义是普通对象）——
> 装饰器要靠 tsconfig 的 `experimentalDecorators` 才能编译，
> 而 tsx 是**按 cwd 找 tsconfig** 的：从别的目录启动会直接编译失败
> （见 [12-a A1](./12-a-需求-应用外壳与上下文.md)「从任何目录启动都指向同一份数据」）。
> 列定义由 `src/db.ts` 调 `Model.initialize()` 挂上。

## 5.3 时间与时区约定 ⚠️

- 所有 DATETIME **按 UTC 墙钟存**（`YYYY-MM-DD HH:mm:ss.SSS`，不带时区）
- 展示层再按浏览器时区转
- ⚠️ **原生 SQL 里拼时间参数时必须用 UTC 墙钟字符串**，
  不能直接把 `Date` 对象交给驱动渲染（不同驱动渲染成本地墙钟，两边对不上）
- 症状参考：「今日对话数在每天的前 8 小时恒为 0」—— 日期桶按本地时间切、
  库里按 UTC 存，差 8 小时
- 走 ORM 的参数化查询不受影响（绑定的是 UTC 值）
- 📌 **写时间的唯一入口是 `src/lib/time.ts` 的 `utcNow()`** ——
  它**进程内单调递增**（同一毫秒多次调用各差 1 毫秒），
  这样 `messages` 表在没有自增序号列的情况下排序也是稳的
- ⚠️ **定宽 → 字典序 = 时间序** —— `ORDER BY created_at DESC` 直接可用，索引也吃得到

## 5.4 敏感数据处理

| 数据          | 存储形式                | 说明                                        |
| ------------- | ----------------------- | ------------------------------------------- |
| 模型 API Key  | **只存 `.env`，不入库** | 启动时读进内存；不落库、不写日志、不回显    |
| 工具入参/出参 | JSON 明文               | ⚠️ 可能含敏感信息 —— 日志里要截断/打码      |
| 记忆内容      | 明文 Markdown 文件      | 本地文件，不外传；能进 git 的是用户自己决定 |
| 对话内容      | 明文                    | 本地文件，不外传                            |

> ⚠️ **模型 API Key 不入库**（只存 `.env`）——
> 所以 `CONFIG_ENCRYPTION_KEY` 这个 env key **本期不需要**，
> 留着一个没人用的加密密钥反而误导人。
> ⚠️ **本期无鉴权** —— 没有账号，也就没有密码要存。

## 5.5 迁移规范

- 迁移文件放 `src/migrations/`，用 **umzug** 执行
- 文件名 `NNN-描述.ts`，编号递增
- ⚠️ **每个迁移必须可回滚**（`down` 要写）
- ⚠️ **建表统一字符集**：SQLite 无字符集概念，但**字段名 / 注释统一用 UTF-8**，
  便于将来迁 MySQL
- ⚠️ **加列要兼容「代码先于迁移上线」**：
  启动时探一次列在不在，不在就把该列从模型定义里摘掉（`Model.removeAttribute`），
  让查询退回老行为 —— **只改 WHERE 没用**（列清单来自模型定义）
- 启动时自动跑 pending 迁移（`yarn dev:backend` 里已有 `yarn migrate &&`）
