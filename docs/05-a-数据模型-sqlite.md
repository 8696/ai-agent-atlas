# 05-a · 数据模型 · SQLite

> 单库单文件：`data/atlas.db`。
> 全部表带 `created_at` / `updated_at`（UTC 墙钟，见 §5.3）。
> 本项目**没有 `tenant_id`** —— 单用户本地，不做租户隔离（见 [01 §1.2](./01-需求与场景.md)）。

## 5.1 核心表

### 用户表（`users`）

> 全库**只有一行**（本地唯一账号）。保留这张表是为了给记忆 / 对话 / 流水一个归属主体。

| 字段             | 类型          | 说明                                        |
| ---------------- | ------------- | ------------------------------------------- |
| `id`             | INTEGER PK    |                                           |
| `email`          | TEXT UNIQUE   | 登录名                                      |
| `password_hash`  | TEXT          | bcrypt                                      |
| `must_change_password` | INTEGER  | 1 = 强制改密（首次初始化为 1）             |
| `preferences`    | TEXT          | JSON：主题、默认模型 scope 等 UI 偏好        |
| `last_login_at`  | DATETIME      |                                           |
| `created_at`     | DATETIME      |                                           |
| `updated_at`     | DATETIME      |                                           |

> ⚠️ `preferences` 是 JSON，SQLite 没有 JSON 类型 → 存 TEXT + 应用层序列化。

### 会话表（`sessions`）

| 字段            | 类型          | 说明                                            |
| --------------- | ------------- | ----------------------------------------------- |
| `id`            | TEXT PK       | nanoid                                          |
| `user_id`       | INTEGER       | 外键 → `users.id`                                |
| `title`         | TEXT          | 首条用户消息截断生成；可手动改                   |
| `status`        | TEXT          | `active` / `archived`                            |
| `favorite`      | INTEGER       | 0/1                                             |
| `summary`       | TEXT          | 长对话摘要（TEXT 存 JSON）                       |
| `metadata`      | TEXT          | JSON：`summary_boundary` / `pending_confirm` 等   |
| `thread_id`     | TEXT          | **LangGraph `thread_id`**（= 会话 id，冗余存一份便于排查） |
| `message_count` | INTEGER       | 冗余计数，避免列表页 COUNT                       |
| `last_active_at`| DATETIME      | 列表排序用                                       |
| `created_at`    | DATETIME      |                                               |
| `updated_at`    | DATETIME      |                                               |

索引：`idx_sessions_user_last (user_id, last_active_at DESC)`、`idx_sessions_favorite (user_id, favorite)`。

### 消息表（`messages`）

| 字段          | 类型       | 说明                                                          |
| ------------- | ---------- | ------------------------------------------------------------- |
| `id`          | TEXT PK    | nanoid                                                        |
| `session_id`  | TEXT       | 外键 → `sessions.id`                                           |
| `user_id`     | INTEGER    | 外键 → `users.id`                                              |
| `role`        | TEXT       | `user` / `assistant` / `system` / `tool`                       |
| `content`     | TEXT       | 纯文本正文（Markdown 源）                                      |
| `parts`       | TEXT       | **JSON 数组**：结构化 part（含工具调用卡片、待确认卡片）        |
| `tool_calls`  | TEXT       | JSON：assistant 消息发起的工具调用（ToolCallSchema 数组）       |
| `tool_results`| TEXT       | JSON：工具执行结果                                             |
| `attachments` | TEXT       | JSON：附件引用                                                 |
| `favorite`    | INTEGER    | 0/1（消息级收藏）                                              |
| `metadata`    | TEXT       | JSON：`created_at` / `model` / `usage` / `stop_reason` 等      |
| `created_at`  | DATETIME   |                                                               |

索引：`idx_messages_session (session_id, created_at)`。

> ⚠️ **`parts` 是「刷新后卡片还在」的依据**：前端渲染工具卡片读的是落库的 `parts`，
> 不是重新拉一次执行记录。改 part 结构要同时改前端渲染分支。

### 模型配置表（`model_configs`）

> 平台默认模型写在 `.env`；这里存的是**用户在 UI 里配的**（可多条、可切换、可分用途）。

| 字段              | 类型     | 说明                                                        |
| ----------------- | -------- | ----------------------------------------------------------- |
| `id`              | TEXT PK  |                                                             |
| `name`            | TEXT     | 显示名                                                       |
| `provider`        | TEXT     | `anthropic` / `openai`                                      |
| `base_url`        | TEXT     | 兼容端点地址；空 = 供应商默认                                |
| `api_key_enc`     | TEXT     | **加密后**的 key（见 §5.4）                                  |
| `model_id`        | TEXT     | 模型标识（发给供应商的 `model`）                             |
| `usage_scope`     | TEXT     | `chat` / `memory` / `summary` / `embedding`                 |
| `enabled`         | INTEGER  | 0/1                                                          |
| `is_default`      | INTEGER  | 同 scope 内是否兜底                                          |
| `fallback_model_id` | TEXT   | 同 scope 另一条；主模型失败时切                             |
| `max_tokens`      | INTEGER  | 单次输出上限                                                 |
| `temperature`     | REAL     |                                                             |
| `thinking_budget` | INTEGER  | 推理预算（0 = 关）                                           |
| `extra`           | TEXT     | JSON：供应商特有参数                                          |
| `created_at` / `updated_at` | DATETIME |                                                     |

索引：`idx_model_configs_scope (usage_scope, enabled)`。

### 提示词版本表（`prompt_versions`）

| 字段         | 类型     | 说明                                             |
| ------------ | -------- | ------------------------------------------------ |
| `id`         | TEXT PK  |                                                  |
| `name`       | TEXT     | 提示词标识（如 `system` / `tool` / `memory`）    |
| `version`    | INTEGER  | 递增版本号                                      |
| `content`    | TEXT     | 正文                                             |
| `status`     | TEXT     | `draft` / `published` / `archived`              |
| `is_active`  | INTEGER  | 当前生效指针（每个 name 最多一行 1）            |
| `created_at` / `updated_at` | DATETIME |                                      |

> ⚠️ **「写生效指针」和「发布」必须在同一个事务里** ——
> 否则会出现「版本已标成 published 但生效指针没换」的半成功，
> 结果是租户/用户改了提示词但对话还跑旧的。

### 通用配置表（`app_settings`）

| 字段         | 类型     | 说明                        |
| ------------ | -------- | --------------------------- |
| `key`        | TEXT PK  | 配置项标识                  |
| `value`      | TEXT     | 值的字符串形式（JSON 也存字符串） |
| `value_type` | TEXT     | `string` / `number` / `boolean` / `json` |
| `updated_at` | DATETIME |                            |

> 配置项的**元信息（类型 / 范围 / 分类 / 说明）写在代码的 registry 里**，
> 这张表只存用户改过的值 —— 跟当前项目「租户只存改过的值」一个路子。

### 工具注册表（`tools`）

> ⚠️ **模型看到的工具池 = 这张表 + Skill 自带工具 + MCP 暴露的工具**，
> 三者用同一套 schema 汇进 `tools/registry.ts`。

| 字段           | 类型     | 说明                                                      |
| -------------- | -------- | --------------------------------------------------------- |
| `id`           | TEXT PK  |                                                          |
| `name`         | TEXT     | **模型看到的调用名**（唯一）                              |
| `source`       | TEXT     | `builtin` / `skill` / `mcp`                               |
| `description`  | TEXT     | **给模型看的描述** —— 改它就是「调教模型调不调它」       |
| `parameters`   | TEXT     | JSON Schema（入参）                                       |
| `enabled`      | INTEGER  | 0/1                                                       |
| `sensitivity`  | TEXT     | `low` / `normal` / `high`（`high` = 需人工确认）          |
| `source_ref`   | TEXT     | `source=skill` → skill 名；`source=mcp` → mcp server id   |
| `config`       | TEXT     | JSON：工具私有配置（如超时、根目录）                      |
| `created_at` / `updated_at` | DATETIME |                                                   |

索引：`idx_tools_name (name)`（唯一）。

### 工具调用流水（`tool_call_logs`）

| 字段          | 类型     | 说明                                                      |
| ------------- | -------- | --------------------------------------------------------- |
| `id`          | TEXT PK  |                                                          |
| `session_id`  | TEXT     |                                                          |
| `message_id`  | TEXT     | 发起的 assistant 消息                                      |
| `tool_name`   | TEXT     |                                                          |
| `source`      | TEXT     | `builtin` / `skill` / `mcp`                               |
| `status`      | TEXT     | `pending` / `running` / `success` / `error` / `rejected` / `timeout` |
| `input`       | TEXT     | JSON：入参                                                |
| `output`      | TEXT     | JSON：出参（截断后）                                      |
| `error`       | TEXT     | 错误信息                                                  |
| `duration_ms` | INTEGER  |                                                          |
| `requires_confirmation` | INTEGER | 0/1                                                  |
| `created_at`  | DATETIME |                                                          |

索引：`idx_tool_logs_session (session_id, created_at)`、`idx_tool_logs_tool (tool_name, created_at)`。

### 长期记忆表（`memories`）

| 字段              | 类型     | 说明                                                  |
| ----------------- | -------- | ----------------------------------------------------- |
| `id`              | TEXT PK  |                                                      |
| `user_id`         | INTEGER  |                                                      |
| `kind`            | TEXT     | `preference`（偏好）/ `fact`（事实）/ `context`（情境）/ `profile`（画像） |
| `content`         | TEXT     | 一条记忆 = 一条事实                                   |
| `source`          | TEXT     | `auto`（自动抽取）/ `manual`（用户手写）              |
| `confidence`      | REAL     | 0~1                                                  |
| `status`          | TEXT     | `active` / `archived`（软删）                        |
| `embedding`       | TEXT     | **JSON 数组**（归一化后的向量），同 `embedding_model` |
| `embedding_model` | TEXT     | 生成它的模型名 —— 换模型后据此判定旧向量作废          |
| `hit_count`       | INTEGER  | 被召回过几次                                          |
| `created_at` / `updated_at` | DATETIME |                                          |

索引：`idx_memories_user_status (user_id, status)`。

> ⚠️ **向量存在这一行里，不放向量库**：
> 量级小（单用户 ≤ 50 条自动记忆 + 手写几条），
> 几百条向量在 DB 里算余弦是毫秒级；
> 而且「有 `user_id` 就自动带上了归属」，不用在向量库那边再手写一遍过滤。
> ⚠️ **代价**：换 embedding 模型后旧向量作废，要重算。

### MCP 服务器表（`mcp_servers`）

| 字段         | 类型     | 说明                                                  |
| ------------ | -------- | ----------------------------------------------------- |
| `id`         | TEXT PK  |                                                      |
| `name`       | TEXT     | 显示名                                                |
| `transport`  | TEXT     | `stdio` / `sse` / `http`                             |
| `command`    | TEXT     | stdio 用的启动命令                                    |
| `args`       | TEXT     | JSON 数组                                            |
| `env`        | TEXT     | JSON 对象                                            |
| `url`        | TEXT     | sse / http 用的地址                                   |
| `enabled`    | INTEGER  |                                                      |
| `tool_policy`| TEXT     | `ask`（默认每次确认）/ `auto` / `off`                |
| `status`     | TEXT     | `disconnected` / `connected` / `error`                |
| `last_error` | TEXT     |                                                      |
| `created_at` / `updated_at` | DATETIME |                                          |

### 图检查点表（`graph_checkpoints`）

> LangGraph checkpointer 的落盘表。**由 LangGraph 的 SQLite saver 管理**，
> 不手写迁移；这里只登记它的存在，升级 LangGraph 时按它的文档走。

| 字段          | 类型     | 说明                                    |
| ------------- | -------- | --------------------------------------- |
| `thread_id`   | TEXT     | 会话 id                                 |
| `checkpoint_ns`| TEXT    | 命名空间                                |
| `checkpoint_id`| TEXT    |                                        |
| `parent_checkpoint_id` | TEXT | 父检查点                        |
| `type`        | TEXT     | `checkpoint` / `metadata` / `writes`    |
| `data`        | TEXT/BLOB| 序列化后的状态                          |
| `created_at`  | DATETIME |                                        |

索引：`idx_gc_thread (thread_id, checkpoint_id)`。

> ⚠️ **这张表是「进程重启后能续跑」的唯一保障**。
> 用进程内的 MemorySaver = 重启后对话状态全丢（会话记录还在，但工具调用链断了）。

### 调用链路表（`traces` / `spans`）

**`traces`**（一轮对话 = 一条）

| 字段          | 类型     | 说明                                  |
| ------------- | -------- | ------------------------------------- |
| `id`          | TEXT PK  |                                       |
| `session_id`  | TEXT     |                                       |
| `user_id`     | INTEGER  |                                       |
| `kind`        | TEXT     | `chat` / `memory` / `summary` / `eval` |
| `name`        | TEXT     | `chat.complete` 等                    |
| `status`      | TEXT     | `success` / `error`                   |
| `duration_ms` | INTEGER  | **用户感知耗时**（不含工具？含，见下） |
| `input`       | TEXT     | JSON                                  |
| `output`      | TEXT     | JSON                                  |
| `error`       | TEXT     |                                       |
| `created_at`  | DATETIME |                                       |

**`spans`**（一个 trace 下多段）

| 字段            | 类型     | 说明                                    |
| --------------- | -------- | --------------------------------------- |
| `id`            | TEXT PK  |                                         |
| `trace_id`      | TEXT     |                                         |
| `parent_span_id`| TEXT     | **父子关系**（工具调用、委派要串成树）  |
| `name`          | TEXT     | `agent.plan` / `tool.invoke` / `llm.generate` |
| `kind`          | TEXT     | `llm` / `tool` / `retrieval` / `agent` / `cost` |
| `input` / `output` | TEXT | JSON                               |
| `duration_ms`   | INTEGER  |                                         |
| `created_at`    | DATETIME |                                         |

索引：`idx_spans_trace (trace_id, created_at)`。

> ⚠️ **`duration_ms` 的语义要写清楚**：对话 trace 的 duration = 用户感知耗时
> （从收到请求到最后一个 chunk 吐完）；记忆抽取 / 摘要**另起一条 trace**，
> 不挂在对话 trace 上 —— 否则「用户等了 12 秒」和「后台抽了个记忆」混在一起。

### 成本流水表（`cost_logs`）

| 字段          | 类型      | 说明                                      |
| ------------- | --------- | ----------------------------------------- |
| `id`          | TEXT PK   |                                           |
| `trace_id`    | TEXT      |                                           |
| `session_id`  | TEXT      |                                           |
| `provider`    | TEXT      |                                           |
| `model`       | TEXT      |                                           |
| `usage_scope` | TEXT      | `chat` / `memory` / `summary`             |
| `prompt_tokens`     | INTEGER |                                      |
| `completion_tokens` | INTEGER |                                      |
| `reasoning_tokens`  | INTEGER | ⚠️ 推理模型的思考 token **全额算输出**   |
| `cached_tokens`     | INTEGER |                                      |
| `cost`        | REAL      | 按当时价格算出来的钱                       |
| `created_at`  | DATETIME  |                                           |

索引：`idx_cost_logs_session (session_id, created_at)`、`idx_cost_logs_created (created_at)`。

### 操作审计表（`audit_logs`）

> 本地也要有：改了模型配置、装了 Skill、接了 MCP server、删了记忆 —— 这些都留痕。
> ⚠️ **绝不记密钥明文**（`api_key` 一律打码）。

| 字段         | 类型     | 说明                                |
| ------------ | -------- | ----------------------------------- |
| `id`         | TEXT PK  |                                     |
| `user_id`    | INTEGER  |                                     |
| `action`     | TEXT     | `MODEL_CREATED` / `SKILL_INSTALLED` / `MCP_ADDED` / `MEMORY_DELETED` … |
| `target_type`| TEXT     |                                     |
| `target_id`  | TEXT     |                                     |
| `details`    | TEXT     | JSON（脱敏后）                      |
| `created_at` | DATETIME |                                     |

### 评测相关表（`evaluation_datasets` / `evaluation_items` / `evaluation_runs` / `evaluation_results`）

> 结构与当前项目一致（见 [08](./08-评测方案.md)），此处只登记表名：
> `evaluation_datasets` / `evaluation_items` / `evaluation_runs` / `evaluation_results`。
> ⚠️ 跑批的 `run_trigger` 列**不能叫 `trigger`**（MySQL 保留字；SQLite 不报错但
> 迁回 MySQL 会炸 —— 统一命名，避免以后换库踩坑）。

## 5.2 表关系

```
users 1───n sessions 1───n messages
              │  │
              │  └──1 graph_checkpoints (thread_id = session_id)
              │
              ├──n messages
              ├──n tool_call_logs
              ├──n traces 1───n spans
              ├──n cost_logs
              └──n memories

model_configs   prompt_versions   app_settings
tools           mcp_servers
audit_logs
evaluation_*
```

## 5.3 时间与时区约定 ⚠️

- 所有 DATETIME **按 UTC 墙钟存**（`YYYY-MM-DD HH:mm:ss.SSS`，不带时区）
- 展示层再按浏览器时区转
- ⚠️ **原生 SQL 里拼时间参数时必须用 UTC 墙钟字符串**，
  不能直接把 `Date` 对象交给驱动渲染（不同驱动渲染成本地墙钟，两边对不上）
- 症状参考：「今日对话数在每天的前 8 小时恒为 0」—— 日期桶按本地时间切、
  库里按 UTC 存，差 8 小时
- 走 ORM 的参数化查询不受影响（绑定的是 UTC 值）

## 5.4 敏感数据处理

| 数据         | 存储形式                       | 说明                                     |
| ------------ | ------------------------------ | ---------------------------------------- |
| 密码         | bcrypt hash                    | 永不返回给前端                           |
| 模型 API Key | **AES-256-GCM 密文**          | 密钥来自 `CONFIG_ENCRYPTION_KEY`        |
| 工具入参/出参 | JSON 明文                   | ⚠️ 可能含敏感信息 —— 日志里要截断/打码   |
| 记忆内容     | 明文                          | 本地文件，不外传                         |

> ⚠️ **`CONFIG_ENCRYPTION_KEY` 没配 = 不许保存模型 key**（不降级成明文）。
> 配了之后**不能换** —— 换了旧密文解不开（会降级到平台默认凭据并告警）。

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
