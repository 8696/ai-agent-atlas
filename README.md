# Atlas

跑在本机上的通用 AI Agent。打开网页就能对话；它会读文件、跑命令、发请求、开浏览器，危险操作先问你再执行。编排用 [LangGraph.js](https://github.com/langchain-ai/langgraphjs)，数据落在本地 SQLite 和 Markdown 里。没有登录，也没有向量数据库。

## 特性

### 对话

- 打开网页直接进聊天。流式逐字输出，支持 Markdown 和思考过程。等首个字时有加载指示。
- 回答边生成边写入 SQLite（约每 2 秒一次）。刷新或重启后，已经说出口的内容还在；被打断的回答会标成「没答完」。
- 会话在侧栏和历史会话页里都能看：搜索、收藏、重命名、删除。超保留期的会话会清掉，收藏的留下。
- 工具调用显示成卡片：工具名、参数、返回、耗时。刷新后卡片还在。
- 18 条斜杠命令在服务端解析，不消耗模型 token。输入 `/` 会弹出补全。
- 长会话超预算会自动折成摘要，也可以手动 `/compress`。
- `/undo` 回退上一轮，`/retry` 重新生成，`/reset` 清空当前上下文（历史记录和工具流水保留）。
- 思考模式可以按会话开关。

四个页面：

| 路径 | 作用 |
| --- | --- |
| `/chat` | 聊天 |
| `/sessions` | 历史会话（搜索、收藏、删除，并能打开日志） |
| `/sessions/:id/log` | 这一次对话的全链路日志 |
| `/stats` | 用量统计（合计、本月、按会话 / 模型 / 用途） |

### 工具

内置 16 个工具，再加上始终可用的 `skill_create` / `skill_update`。带脚本的技能和 MCP server 暴露的工具进同一个池子。

编排是 LangGraph.js 状态图：`prepare → plan → tools → plan → … → answer`。单轮步数有上限（默认 5），同一个工具连续调用也会被拦住。不需要确认的多个工具可以并行。每轮按相关度裁剪暴露给模型的工具；命中触发词的工具会强制留下来。

`SHELL_ENABLED=false` 时模型看不到 `shell`。`BROWSER_ENABLED=false` 或没装 Playwright 时不注册 `browser`。

### 确认与恢复

写文件、删文件、跑命令、跑沙箱代码、开浏览器、跑技能脚本、接进来的第三方工具，默认先弹确认卡片。一轮里有多个危险操作时，可以点「批准并放行本轮剩余的」。

确认挂起写进 SQLite 检查点。后端重启后卡片还在，批准后从断点接着跑。永久删除记忆也会先问一次。

### 记忆

长期记忆是两个 Markdown 文件：`data/memory/MEMORY.md` 和 `USER.md`，可以直接打开改。对话里说「记住 X」「把那条删掉」「清空记忆」也会改这两个文件。写进记忆前会做安全扫描，并有字符上限。

每轮按相关度召回，带用量，受条数和 token 预算限制。跨会话检索走 SQLite FTS5 + trigram，中文短句能搜到。会话结束后会尝试抽出值得记住的事实；这一轮如果已经手动写过记忆，就不再自动抽一遍。

### 技能、MCP、定时任务、子代理

- 技能包是 `data/skills/<name>/SKILL.md`。命中后把说明注入系统提示词，受条数和 token 预算限制。
- 对话里可以让模型新建或改写技能。带脚本的技能会注册成 `skill_<名字>`，走同一套确认闸。
- 一轮里工具调用达到阈值（默认 4 次）后，可以把这次做法沉淀成新技能。一轮最多建一个，同一技能 24 小时内不重复自动更新。
- MCP server 配在 `data/mcp.json`，支持 stdio、SSE、HTTP。工具名是 `<server>__<tool>`。一个 server 挂了不影响其他 server，也可以只暴露白名单里的工具。第三方工具默认每次都要确认。
- 定时任务写在 `data/cron.json`。对话里用自然语言描述时间，由模型解析成 cron。到点自己跑；需要人工确认的步骤会跳过并记一笔。
- `spawn_subagent` 把子任务派给看不到主对话历史的子代理，可以并行，结果以摘要回灌（也可要求 JSON）。子代理还能再派一层（默认最多 2 层）。子代理里的危险操作照样要确认。

### 模型与成本

三个环境变量切换供应商：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。Anthropic 兼容和 OpenAI 兼容端点都可以。主模型失败且还没开始输出时，自动切到备用模型。

记忆抽取、会话摘要、检索摘要、技能沉淀判断、cron 解析可以走辅助模型（`LLM_AUX_*`）。没配就用主模型。系统提示词可以打开 Anthropic 提示词缓存（`LLM_PROMPT_CACHE`），端点不支持时自动退回。

每轮把 token 和费用记进 `cost_logs`。月度预算到达告警线会提示，也可以设成超预算直接拦住。`/usage`、用量统计页和 `yarn cost:report` 都能看用量。`MAX_TOKENS_PER_TURN` 可以给单轮设上限（默认不限）。

### 观测

一次对话的全过程会落库：上下文装配、模型请求与响应、工具判定与执行、记忆和技能的变化。落库前会打码。`/log` 看摘要，`/sessions/:id/log` 逐条展开原文。`/context` 看这一轮发给模型的每一段各占多少字，不消耗 token。

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

打开前端会直接进入聊天页。没配模型时，页面会提示去改 `.env`。

生产模式：

```bash
yarn build
yarn migrate    # 生产环境不会自动跑迁移
yarn start
```

要用无头浏览器，先装 Chromium：

```bash
npx playwright install chromium
```

## 配置

配置都在项目根的 `.env`，启动时用 zod 校验。改完重启生效。提示词、人格和记忆是内容文件。

| 要改什么 | 放哪里 |
| --- | --- |
| 模型 | `.env` 的 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` |
| 备用模型 | `.env` 的 `LLM_FALLBACK_*`（留空表示没有兜底） |
| 辅助模型 | `.env` 的 `LLM_AUX_*`（留空则脏活也走主模型） |
| 项目指令 | `AGENTS.md`（每轮注入前 6000 字，超长会截断；模型可以 `read_file` 读全文） |
| 人格 | `SOUL.md`（也认 `SOUL*.md`） |
| 系统提示词 | `prompts/*.md` |
| 长期记忆 | `data/memory/MEMORY.md`、`data/memory/USER.md` |
| 技能 | `data/skills/<name>/SKILL.md` |
| MCP | `data/mcp.json` |
| 定时任务 | `data/cron.json` |
| 单价 | `data/pricing.json` |

文件工具的工作区就是项目根。项目外面的路径会被拒绝。`AGENTS.md`、`SOUL*.md` 和 `prompts/*.md` 不允许被工具改写。

`.env.example` 里有每一项的注释。模型端点示例（都提供 Anthropic 兼容接口）：

| 供应商 | `LLM_BASE_URL` | `LLM_MODEL` |
| --- | --- | --- |
| 智谱 | `https://open.bigmodel.cn/api/anthropic` | `glm-5.3` |
| DeepSeek | `https://api.deepseek.com/anthropic` | `deepseek-v4-pro` |
| 通义千问 | `https://dashscope.aliyuncs.com/apps/anthropic` | `qwen3.8-max` |
| MiniMax | `https://api.minimaxi.com/anthropic` | `MiniMax-M3` |

回环地址上的本地模型可以直接用，也可以不填 Key。指向云厂商元数据地址或链路本地地址会被拒绝。

## 使用

在聊天框里直接说人话即可，例如：

- 「我桌面上有哪些文件？」
- 「把 `notes.md` 里没做完的 TODO 列出来」
- 「帮我跑一下测试」（会先弹出确认）
- 「记住，我用 yarn 不用 npm」

斜杠命令：

| 命令 | 作用 |
| --- | --- |
| `/help` | 列出全部命令 |
| `/new` | 新建会话 |
| `/reset` | 清空当前会话上下文（历史记录与工具流水保留） |
| `/model [名称]` | 查看或切换本会话模型 |
| `/personality [文件名]` | 查看或切换人格文件 |
| `/retry` | 重新生成上一轮回答 |
| `/undo` | 撤销上一轮 |
| `/compress` | 手动压缩当前会话 |
| `/usage` | 本月与本会话的用量 |
| `/memory [list\|delete\|clear]` | 查看、删除或清空长期记忆 |
| `/skills` | 列出已安装技能 |
| `/thinking on\|off` | 思考模式开关 |
| `/stop` | 停止当前输出 |
| `/context [问题]` | 看这一轮给模型发了什么 |
| `/tools [工具名]` | 工具总览（来源、敏感档、要不要确认） |
| `/cron` | 列出定时任务 |
| `/export [md\|json]` | 把当前会话导出到 `data/exports/` |
| `/log` | 看这个会话的全链路日志摘要 |

命令行：

| 命令 | 作用 |
| --- | --- |
| `yarn dev` | 前后端一起启动 |
| `yarn memory:list` | 查看长期记忆（还有 `add` / `edit` / `archive` / `delete` / `clear`） |
| `yarn search <关键词>` | 跨会话检索 |
| `yarn cron:list` | 查看定时任务（还有 `add` / `remove`） |
| `yarn cost:report` | 用量报表 |
| `yarn tool:logs` | 工具调用流水 |
| `yarn audit:logs` | 审计日志 |
| `yarn backup` | 备份数据库和记忆文件 |
| `yarn env:check` | 核对 `.env` 与 `.env.example` |

## 工具

| 工具 | 作用 | 默认要确认 |
| --- | --- | --- |
| `read_file` / `list_dir` / `search_files` | 读文件、列目录、在项目里搜 | 否 |
| `write_file` / `delete_path` | 写文件、删除路径 | 是 |
| `shell` | 执行命令（可整体关闭） | 是 |
| `http_request` / `web_fetch` | 发请求、抓网页 | 否 |
| `web_search` | 联网搜索 | 否 |
| `current_time` | 当前时间 | 否 |
| `execute_code` | 在受限子进程里跑 JavaScript | 是 |
| `browser` | Playwright 无头浏览器 | 是 |
| `memory` | 查看、新增、改写、归档记忆 | 否 |
| `memory_forget` | 删除或清空记忆 | 是 |
| `cron` | 在对话里增删查改定时任务 | 否 |
| `spawn_subagent` | 把子任务派给隔离上下文的子代理 | 否 |
| `skill_create` / `skill_update` | 新建或改写技能说明 | 否 |
| `skill_<名字>` | 跑某个技能自带的脚本 | 是 |

搜索后端由 `WEB_SEARCH_PROVIDER` 决定：`auto`（默认）、`searxng`、`tavily`、`brave`、`duckduckgo`。`auto` 时，配了 `WEB_SEARCH_URL` 用 SearXNG，配了 Key 用 Tavily，否则用免 key 的 DuckDuckGo。前面的后端失败会顺着这条链往下试，DuckDuckGo 始终垫底。

`browser` 有五个动作：`navigate`、`click`、`type`、`read`、`screenshot`。域名白名单写在 `BROWSER_ALLOWED_DOMAINS`，每个请求都会再查一次。

`execute_code` 跑在受限子进程里，没有 `require`、`process`、`fetch`。脚本里可以用 `atlas.call()` 调别的工具，中间结果不进对话上下文。沙箱里只能再调用不需要确认的工具。

## 安全

这个 Agent 能读盘、跑命令、出网。默认边界是：

- 服务只听 `127.0.0.1`。改成非回环地址时，启动日志会打出红色告警。
- 文件路径会解析符号链接，必须落在项目根里。删除不会跟着软链跑到项目外。
- 出网拒绝私网、回环和云元数据地址，重定向逐跳检查。`ALLOW_PRIVATE_EGRESS=true` 才放行私网。
- `rm -rf /`、`mkfs`、`shutdown` 这类命令直接拒绝。
- 子进程拿到的环境变量是裁过的，密钥不会整份继承出去。
- 工具返回标成不可信数据。注入检测命中后收紧本轮可用的工具档位。日志、工具输出和全链路日志里的密钥会打码。

细节见 [安全方案](./docs/10-安全方案.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js ≥ 22.4 · TypeScript · ESM |
| 编排 | LangGraph.js 1.5 |
| 模型 | LangChain ChatModel（Anthropic / OpenAI 兼容端点） |
| 后端 | Koa 3 · Sequelize · SQLite（含 FTS5） |
| 前端 | React 19 · Vite · Ant Design 6 |
| 流式协议 | AI SDK UI Message Stream |
| 测试 | Vitest · Playwright |

## 开发

```bash
yarn run check      # 类型检查 + lint
yarn test:unit      # 单元测试
yarn test           # 单元测试与集成测试
yarn test:e2e       # 首次需 npx playwright install chromium
yarn migrate        # 跑数据库迁移
yarn env:check      # 核对 .env 与 .env.example
```

`yarn run check` 要写成这样。`yarn check` 是 Yarn 1 自带的依赖树检查，会盖过项目里的脚本。

```
atlas-agent/
├── src/            后端：编排、工具、技能、会话、记忆、全链路日志
├── web/            前端：聊天 / 历史会话 / 会话日志 / 用量统计
├── prompts/        系统提示词（system / tool / memory / summary / skill）
├── assets/sandbox/ execute_code 的子进程脚本
├── data/           本地数据（不进 git）：库、记忆、技能、MCP、定时任务、导出
├── scripts/        迁移、备份、记忆、检索、定时任务、审计
├── tests/          unit / integration / e2e
└── docs/           规格文档
```

规格从 [需求与场景](./docs/01-需求与场景.md) 和 [系统架构](./docs/02-系统架构与目录.md) 读起。给改这个仓库的人看的操作说明在 [AGENTS.md](./AGENTS.md)。

## License

MIT
