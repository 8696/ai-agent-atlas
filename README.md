# Atlas

> **跑在本地的通用型 AI Agent** —— 后台起 HTTP 服务，Web 端打开就能聊；
> Agent 判断意图后调用工具（文件 / 目录 / 命令 / 请求 / 时间），
> 用 **LangGraph.js** 编排，可中断、可确认、可断点恢复。

```
┌────────────┐   SSE / REST   ┌──────────────────────┐   工具   ┌──────────────┐
│  浏览器     │ ─────────────► │  Atlas 后端（Koa）    │ ───────► │ 文件 / 命令  │
│ React 19    │ ◄───────────── │  LangGraph.js 编排    │ ◄─────── │ HTTP / 时间   │
│ AntD 6     │                └──────────┬───────────┘         └──────────────┘
└────────────┘                           │
                                 ┌─────┴──────┐
                                 │ SQLite     │  对话 / 配置 / 记忆 / trace
                                 │ sqlite-vec │  记忆向量 / Skill 索引
                                 └────────────┘
```

---

## 特性

- **本地单用户**：一个实例 = 一个使用者，数据全在自己机器上，不需要 Docker / 云服务
- **LangGraph.js 编排**：状态图 + 条件边 + checkpointer + `interrupt` 人工确认
- **流式对话**：逐字输出；工具调用卡片、待确认卡片都落库，刷新后还在
- **危险操作要人确认**：Shell / 写文件默认弹确认；路径沙箱 + 出网校验 + 命令黑名单三道闸
- **长期记忆**：自动抽取「关于用户的事实」，按相关性召回，用户可看可改可删
- **可扩展**：统一工具注册表 —— 内置工具、Skill 自带脚本、MCP server 暴露的工具走同一条路
- **AI 配置在 UI 里**：模型列表（多供应商 / 多用途 / 备用模型）、提示词多版本（草稿→发布→回滚）、通用配置 KV
- **可观测**：每轮对话一条 trace，工具调用是一条 span；成本四维拆解

> **当前状态：骨架阶段** —— 28 份规格文档已写完，28 条需求全部标记「待实现」。
> 状态表见 [docs/12-e §E5](./docs/12-e-需求-观测安全与验收.md)。

---

## 技术栈

| 层       | 选型                                                            |
| -------- | --------------------------------------------------------------- |
| 运行时   | Node ≥ 22.4 · TypeScript 7（strict）· ESM                        |
| 编排     | **LangGraph.js**（`@langchain/langgraph` 1.5.x）                |
| 模型     | LangChain Core ChatModel（Anthropic / OpenAI 兼容端点）           |
| 消息流   | AI SDK UI Message Stream（前端 `useChat`）+ 后端事件翻译层       |
| 后端     | Koa 3 · `@koa/router` · zod · Sequelize 6 + umzug · SQLite        |
| 向量     | sqlite-vec（独立文件，独立连接）                                 |
| 前端     | React 19 · Vite 8 · Ant Design **6** · react-router-dom 7 · zustand |
| 测试     | Vitest 5 · Playwright                                           |

> ⚠️ **Ant Design 是 v6**（不是 v4/v5），`Alert message` → `title`、
> `destroyOnClose` → `destroyOnHidden`。
> ⚠️ **模型调用走 LangChain，AI SDK 只用于协议** —— 不要在后端用 `streamText` 起第二套流式栈。

---

## 快速开始

```bash
yarn install
cp .env.example .env      # ⚠️ 必须填 JWT_SECRET（≥ 16 位），否则启动失败
yarn dev
```

- 前端 <http://localhost:5180> · 后端 <http://localhost:3100>
- 首次访问会引导创建本地账号 → 强制改密 → 去「设置 → 模型」填一条模型 → 回聊天页开聊

**不用 Docker，不用 MySQL，不用 Qdrant。**

### 生产模式

```bash
yarn build
yarn migrate      # ⚠️ 生产不自动跑迁移，先跑再起
yarn start
```

### 常用命令

| 命令                | 作用                                       |
| ------------------- | ------------------------------------------ |
| `yarn dev`          | 前后端一起起（后端带热重载）                |
| `yarn typecheck`    | 三份 tsconfig 全量类型检查                 |
| `yarn test`         | unit + integration                          |
| `yarn test:e2e`     | Playwright（首次要先 `npx playwright install chromium`） |
| `yarn migrate`      | 跑 pending 迁移                             |
| `yarn backup`       | 备份业务库 + 向量库                          |
| `yarn env:check`    | 校验 `.env` / `.env.example` 结构一致        |

---

## 文档

> 28 份主题文档（编号 01–13，含子文档）。**文档 = 系统规格**：改了代码要改文档。

| 编号  | 文档                                                              | 用途                       |
| ----- | ----------------------------------------------------------------- | -------------------------- |
| 01    | [需求与场景](./docs/01-需求与场景.md)                              | 业务目标 · 角色 · Out of Scope |
| 02    | [系统架构与目录](./docs/02-系统架构与目录.md)                      | 架构图 · 数据流 · 目录结构  |
| 03-a  | [技术栈 · 工程化规范](./docs/03-a-技术栈-工程化规范.md)             | 工具链 · 目录 · 提交 · 环境变量 |
| 03-b  | [技术栈 · 后端栈](./docs/03-b-技术栈-后端栈.md)                     | Koa · **LangGraph 用法** · Sequelize |
| 03-c  | [技术栈 · 前端栈](./docs/03-c-技术栈-前端栈.md)                     | Vite · React · AntD · 路由  |
| 04-a  | [UI · 总则布局与菜单](./docs/04-a-ui-总则布局与菜单.md)             | 设计总则 · 布局 · 菜单树    |
| 04-b  | [UI · 登录与聊天页](./docs/04-b-ui-登录与聊天页.md)                 | 登录 / 改密 / 聊天页 / 工具卡片 |
| 04-c  | [UI · 设置页](./docs/04-c-ui-设置页.md)                            | 设置类页面规格              |
| 04-d  | [UI · 公共组件](./docs/04-d-ui-公共组件.md)                         | 公共组件 · 错误页           |
| 05-a  | [数据模型 · SQLite](./docs/05-a-数据模型-sqlite.md)                 | 表结构                      |
| 05-b  | [数据模型 · 向量库](./docs/05-b-数据模型-向量库.md)                 | sqlite-vec 设计             |
| 06    | [大模型与 Embedding](./docs/06-大模型与Embedding.md)               | 供应商 · 模型解析 · 提示词组装 |
| 07-a  | [模块 · LLM 与 Prompt](./docs/07-a-模块-llm与prompt.md)            | 模块 01-03                 |
| 07-b  | [模块 · 工具与 Skill](./docs/07-b-模块-工具与skill.md)              | 模块 04-06                 |
| 07-c  | [模块 · 记忆与会话](./docs/07-c-模块-记忆与会话.md)                | 模块 07-09                 |
| 07-d  | [模块 · 编排](./docs/07-d-模块-编排.md)                            | 模块 10-12（LangGraph）    |
| 07-e  | [模块 · 可观测与评测](./docs/07-e-模块-可观测与评测.md)            | 模块 13-15                 |
| 07-f  | [模块 · 安全与全栈](./docs/07-f-模块-安全与全栈.md)                | 模块 16-18                 |
| 08    | [评测方案](./docs/08-评测方案.md)                                   | 评测集 · 裁判 · A/B 对比    |
| 09    | [观测方案](./docs/09-观测方案.md)                                   | trace · 指标 · 告警 · 日志  |
| 10    | [安全方案](./docs/10-安全方案.md)                                   | 威胁模型 · 三道闸 · 审计    |
| 11    | [部署运维与成本](./docs/11-部署运维与成本.md)                       | 启动 · 备份 · 重置 · 成本   |
| 12-a  | [需求 · 应用外壳与账号](./docs/12-a-需求-应用外壳与账号.md)          | A 类需求                   |
| 12-b  | [需求 · 对话与编排](./docs/12-b-需求-对话与编排.md)                  | B 类需求                   |
| 12-c  | [需求 · 工具技能与扩展](./docs/12-c-需求-工具技能与扩展.md)          | C 类需求                   |
| 12-d  | [需求 · 记忆与配置](./docs/12-d-需求-记忆与配置.md)                  | D 类需求                   |
| 12-e  | [需求 · 观测安全与验收](./docs/12-e-需求-观测安全与验收.md)          | E 类需求 + **需求总表**    |
| 13    | [扩展指南](./docs/13-扩展指南.md)                                   | 怎么加需求 / 加模块 / 加工具 |

### 阅读顺序建议

1. [01 需求与场景](./docs/01-需求与场景.md) —— 这个产品是什么
2. [02 系统架构与目录](./docs/02-系统架构与目录.md) —— 怎么搭的
3. [12-a ~ 12-e](./docs/12-a-需求-应用外壳与账号.md) —— **要做什么**（28 条需求 + 验收标准）
4. [03-b §B.5](./docs/03-b-技术栈-后端栈.md) —— **LangGraph 怎么用**（本项目的核心）
5. [13 扩展指南](./docs/13-扩展指南.md) —— 往里加东西的规矩

---

## 目录结构

```
atlas-agent/
├── src/
│   ├── agent/       ★ LangGraph 编排层（state / graph / nodes / checkpointer / events）
│   ├── tools/       工具注册表 + 内置 / Skill / MCP 工具
│   ├── services/    业务：会话 / 记忆 / 提示词 / 模型 / 成本 / trace
│   ├── gateway/     HTTP 路由
│   ├── models/      Sequelize 模型
│   ├── migrations/  umzug 迁移
│   ├── lib/         工具库：安全闸 / 预算 / 埋点 / 路径沙箱
│   └── server.ts    启动入口
├── web/             前端（pages / components / layouts / lib）
├── shared/          前后端共用类型
├── data/            本地数据（⚠️ 不进 git）：atlas.db / vectors.db / skills / workspace
├── logs/            运行日志
├── scripts/         migrate / backup / seed
├── tests/           unit / integration / e2e
└── docs/            28 份规格文档
```

---

## 安全边界

Agent 能读文件、跑命令、发请求 —— 这三件事都有闸：

| 闸           | 规则                                                        |
| ------------ | ----------------------------------------------------------- |
| **路径沙箱** | 所有文件路径 resolve（含 symlink）后必须在工作区内           |
| **出网校验** | 拒私网 / 回环 / 云元数据地址；**重定向逐跳校验**              |
| **命令黑名单** | `rm -rf /` · `mkfs` · `dd if=` · `shutdown` 等直接拒绝         |
| **默认确认** | `high` 档工具（Shell / 写文件 / MCP / Skill 脚本）**默认要人确认** |
| **注入防护** | 工具结果标「不可信数据」；检测命中只告警 + 收紧档位，不直接拒答 |

详见 [10 安全方案](./docs/10-安全方案.md)。

---

## License

MIT
