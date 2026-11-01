# Atlas

跑在你自己电脑上的通用 AI Agent。打开网页就能对话；它会读文件、跑命令、发请求、开浏览器，危险操作先问你再执行。编排用 [LangGraph.js](https://github.com/langchain-ai/langgraphjs)，数据落在本地 SQLite 和 Markdown 文件里，不需要登录，也不需要向量数据库。

## 特性

### 对话

- 网页打开就能聊，流式逐字输出，支持 Markdown 和思考过程。
- 等首个字的空窗有加载指示，不会看起来像卡住。
- 会话落在本地 SQLite：侧栏列表、历史会话页、搜索、收藏、保留期清理。刷新后历史还在。
- 工具调用显示成卡片：调了哪个工具、参数、返回、耗时。刷新后卡片还在。
- 17 条斜杠命令（`/help`、`/new`、`/compress`、`/usage`、`/memory`、`/skills`、`/context`、`/cron`、`/tools`、`/export` 等），服务端解析，不消耗模型 token。
- `/context` 能看清「这一轮到底给模型发了什么」：每一段上下文各占多少字、是否截断、为什么被选中。
- 长会话超预算会自动折成摘要，也可以手动 `/compress`。
- `/undo` 回退上一轮，`/retry` 重新生成，`/reset` 清空当前上下文（历史记录保留）。
- 思考模式可以按会话开关。

### 工具

- 16 个内置工具：读 / 写 / 列目录 / 删除 / 搜索文件、Shell、HTTP 请求、抓网页、联网搜索、当前时间、沙箱代码、无头浏览器、记忆读写、记忆删除、定时任务管理、派子代理。
- 编排是 LangGraph.js 状态图：判断意图、调工具、结果回灌、再判断，直到可以回答。单轮步数有上限，同一个工具连续调用也会被拦住。
- 每轮按相关度裁剪暴露给模型的工具，避免一次塞进全部工具。
- 不需要确认的多个工具可以并行执行。

### 确认与恢复

- 写文件、删文件、跑命令、开浏览器、跑技能脚本、接进来的第三方工具，默认先弹确认卡片，批准才执行。
- 一轮里有多个危险工具时，可以点「批准并放行本轮剩余的」，不用一个个点。
- 确认挂起会写进检查点。后端重启后卡片还在，批准后从断点接着跑。
- 永久删除记忆也会先问一次。

### 记忆

- 长期记忆是两个 Markdown 文件：`data/memory/MEMORY.md` 和 `USER.md`，可以直接打开改。
- 对话里说「记住 X」「把那条删掉」「清空记忆」就会改文件，不必去命令行。
- 写进记忆前会做安全扫描，并有字符上限。
- 每轮按相关度召回，带用量，受条数和 token 预算限制。
- 跨会话检索走 SQLite FTS5 + trigram，中文短句能搜到，不需要 embedding 模型。
- 会话结束后会尝试从对话里抽出值得记住的事实；这一轮如果已经手动写过记忆，就不再自动抽一遍。

### 技能、MCP、定时任务、子代理

- 技能包是 `data/skills/<name>/SKILL.md`。命中后把说明注入系统提示词，受条数和 token 预算限制。
- 带脚本的技能会注册成一个工具，走同一套确认闸。
- 一轮里工具调用达到阈值后，可以把这次做法沉淀成新技能（有冷却，一轮最多建一个）。
- MCP server 配在 `data/mcp.json`，支持 stdio、SSE、HTTP。工具名带 server 前缀，一个 server 挂了不影响其他 server，也可以只暴露白名单里的工具。
- 定时任务写在 `data/cron.json`，可以用自然语言描述时间，由模型解析成 cron。到点自己跑；需要人工确认的步骤会跳过并记一笔，不会把调度挂死。
- `spawn_subagent` 把子任务派给看不到主对话历史的子代理，可以并行，结果以摘要回灌。子代理里的危险操作照样要确认。

### 模型与成本

- 三个环境变量切换供应商：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。Anthropic 兼容和 OpenAI 兼容端点都可以。
- 主模型失败且还没开始输出时，自动切到备用模型。
- 可配置推理预算、温度和单次输出上限。
- 每轮把 token 和费用记进 `cost_logs`。月度预算到达告警线会提示，也可以设成超预算直接拦住。
- `/usage` 和 `yarn cost:report` 查看用量。

### 安全

- 默认只听回环地址。改成对局域网开放时，启动日志会打出告警。
- 文件路径会解析符号链接，必须落在工作区里。`AGENTS.md`、`SOUL.md` 这类上下文文件不允许被工具改写。
- 出网拒绝私网、回环和云元数据地址，重定向逐跳检查。
- 命令有黑名单；`SHELL_ENABLED=false` 时模型也看不到 `shell`。
- 沙箱代码跑在受限子进程里，没有 `require`、`process`、`fetch`。沙箱里只能再调用不需要确认的工具。
- 浏览器按域名白名单限制，每个请求都再查一次。
- 工具返回标成不可信数据。注入检测命中后收紧本轮可用的工具档位。日志和工具输出里的密钥会打码。

## 快速开始

需要 Node.js ≥ 22.4 和 Yarn ≥ 1.22。

```bash
yarn install
cp .env.example .env
# 编辑 .env，填上 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
yarn dev
```

- 前端：<http://localhost:5180>
- 后端：<http://localhost:3100>

打开前端会直接进入聊天页。没配模型时，页面会提示去改 `.env`，不会报一个空白的 500。

生产模式：

```bash
yarn build
yarn migrate    # 生产环境不会自动跑迁移
yarn start
```

## 配置

所有配置都在项目根目录的 `.env`，启动时用 zod 校验。改完重启生效。提示词、人格和记忆是内容文件，不放在环境变量里。

| 要改什么 | 放哪里 |
| --- | --- |
| 模型 | `.env` 的 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` |
| 备用模型 | `.env` 的 `LLM_FALLBACK_*`（留空表示没有兜底） |
| 项目指令 | `AGENTS.md`（每轮注入，超长会截断） |
| 人格 | `SOUL.md` |
| 系统提示词 | `prompts/*.md` |
| 长期记忆 | `data/memory/MEMORY.md`、`data/memory/USER.md` |
| 技能 | `data/skills/<name>/SKILL.md` |
| MCP | `data/mcp.json` |
| 定时任务 | `data/cron.json` |

`.env.example` 里有每一项的注释。模型端点示例（都提供 Anthropic 兼容接口）：

| 供应商 | `LLM_BASE_URL` | `LLM_MODEL` |
| --- | --- | --- |
| 智谱 | `https://open.bigmodel.cn/api/anthropic` | `glm-5.3` |
| DeepSeek | `https://api.deepseek.com/anthropic` | `deepseek-v4-pro` |
| 通义千问 | `https://dashscope.aliyuncs.com/apps/anthropic` | `qwen3.8-max` |
| MiniMax | `https://api.minimaxi.com/anthropic` | `MiniMax-M3` |

回环地址上的本地模型可以直接用。指向云厂商元数据地址或链路本地地址会被拒绝。

## 使用

在聊天框里直接说人话即可，例如：

- 「我桌面上有哪些文件？」
- 「把 `notes.md` 里没做完的 TODO 列出来」
- 「帮我跑一下测试」（会先弹出确认）
- 「记住，我用 yarn 不用 npm」

输入 `/` 会弹出斜杠命令。这些命令在服务端解析，不消耗模型 token：

| 命令 | 作用 |
| --- | --- |
| `/help` | 列出全部命令 |
| `/new` | 新建会话 |
| `/reset` | 清空当前会话上下文（历史记录保留） |
| `/model [名称]` | 查看或切换本会话模型 |
| `/personality [文件名]` | 查看或切换人格文件 |
| `/retry` | 重新生成上一轮回答 |
| `/undo` | 撤销上一轮 |
| `/compress` | 手动压缩当前会话 |
| `/usage` | 本月与本会话的用量 |
| `/memory` | 查看、删除或清空长期记忆 |
| `/skills` | 列出已安装技能 |
| `/thinking on\|off` | 思考模式开关 |
| `/stop` | 停止当前输出 |
| `/context [问题]` | 看这一轮给模型发了什么（上下文构成报告） |
| `/tools [工具名]` | 工具总览（来源 · 敏感档 · 要不要确认） |
| `/cron` | 列出定时任务 |
| `/export [md\|json]` | 把当前会话导出成文件 |

命令行：

| 命令 | 作用 |
| --- | --- |
| `yarn dev` | 前后端一起启动 |
| `yarn memory:list` | 查看长期记忆 |
| `yarn search <关键词>` | 跨会话检索 |
| `yarn cron:list` | 查看定时任务 |
| `yarn cost:report` | 用量报表 |
| `yarn tool:logs` | 工具调用流水 |
| `yarn audit:logs` | 审计日志 |
| `yarn backup` | 备份数据库和记忆文件 |

## 内置工具

| 工具 | 作用 |
| --- | --- |
| `read_file` / `write_file` / `list_dir` / `delete_path` / `search_files` | 工作区内的文件与目录 |
| `shell` | 执行命令（可整体关闭） |
| `http_request` / `web_fetch` | 发请求、抓网页 |
| `web_search` | 联网搜索（默认免 key 的 DuckDuckGo，也可配 SearXNG / Tavily / Brave） |
| `browser` | Playwright 无头浏览器（需安装浏览器，可按域名白名单限制） |
| `execute_code` | 在受限子进程里跑 JavaScript |
| `current_time` | 当前时间 |
| `memory` / `memory_forget` | 增改记忆；删除和清空会再确认一次 |
| `spawn_subagent` | 把子任务派给看不到主对话的子代理（还能再派一层，限深度） |
| `cron` | 在对话里增删查改定时任务 |

技能自带的脚本和 MCP 暴露的工具会进同一个工具池。第三方工具默认每次都要确认。

## 安全

这个 Agent 能读盘、跑命令、出网。默认边界是：

- 服务只听 `127.0.0.1`。改成 `0.0.0.0` 时，启动日志会打出告警：局域网里的人都能用它执行命令。
- 文件路径会解析符号链接，必须落在工作区里。
- 出网拒绝私网、回环和云元数据地址，重定向逐跳检查。
- `rm -rf /`、`mkfs`、`shutdown` 这类命令直接拒绝。
- 高敏感工具默认要人点确认。

细节见 [安全方案](./docs/10-安全方案.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js ≥ 22.4 · TypeScript · ESM |
| 编排 | LangGraph.js |
| 模型 | LangChain ChatModel（Anthropic / OpenAI 兼容端点） |
| 后端 | Koa · Sequelize · SQLite（含 FTS5） |
| 前端 | React 19 · Vite · Ant Design 6 |
| 流式协议 | AI SDK UI Message Stream |
| 测试 | Vitest · Playwright |

## 开发

```bash
yarn run check     # 类型检查 + lint
yarn test          # 单元测试与集成测试
yarn test:e2e      # 首次需 npx playwright install chromium
yarn migrate       # 跑数据库迁移
yarn env:check     # 核对 .env 与 .env.example
```

```
atlas-agent/
├── src/            后端：编排、工具、技能、会话、记忆
├── web/            前端：聊天页 / 历史会话页
├── prompts/        系统提示词
├── data/           本地数据（不进 git）：库、记忆、技能、MCP、定时任务
├── scripts/        迁移、备份、记忆与定时任务命令
├── tests/          unit / integration / e2e
└── docs/           规格文档
```

规格文档从 [需求与场景](./docs/01-需求与场景.md) 和 [系统架构](./docs/02-系统架构与目录.md) 读起。给 AI 工程师看的操作说明在 [AGENTS.md](./AGENTS.md)。

## License

MIT
