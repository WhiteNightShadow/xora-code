# 02｜总体架构

## 1. 分层与进程

```
[bootstrap：electron主进程里的极小启动器，随安装包发布，几乎不改]
   选择应用包槽位 · 启动健康检查与自动回滚 · 修复模式
   窗口、托盘、通知、防休眠、密钥（safeStorage）、deep link
        │ 加载验签通过的应用包
        ▼
[ui：renderer，无状态]  react应用；可多开、可关，崩溃不影响任务
        │ MessagePort（json-rpc，schema校验，方法白名单）
        ▼
[host：utilityProcess，常驻]
   线程状态机 · 审批与策略 · worktree · 审阅与检查点 · agent名册、任务与工作流 · 调度与触发
   提示词拼装 · 供应商与模型目录 · 计量与预算 · 扩展管理 · 存储
        │ acp（json-rpc over stdio）
        ▼
[引擎：子进程]  xora engine（node） | 外部acp agent（codex、claude、kimi code、opencode、grok、dsh …）
        │ https
        ▼
[模型]  api · 订阅 · 本地
```

要点：

- **bootstrap要小**：它是唯一不能热更新的js，目标在2000行以内，只做启动、回滚、修复和系统集成。业务逻辑全部放在可热更新的应用包里。
- **代码位置**：
  - ui、host、xora engine都在应用包里。
  - preload和原生模块（node-pty）在shell里。原生模块和electron abi绑定，应用包的清单要声明自己需要的abi。
- **引擎启动方式**：xora engine用`ELECTRON_RUN_AS_NODE=1`加electron可执行文件启动，用的是electron自带的node，不用另外打包node。
- **进程生命周期**：
  - 窗口关了任务继续跑（托盘常驻）。
  - host崩溃时由bootstrap重启，并从日志恢复线程状态。
  - 引擎崩溃只影响它所在的项目。
- **引擎进程粒度**：默认每个项目一个，进程内跑多个会话（acp本来就支持）。worktree线程靠session的`cwd`区分。

## 2. 技术栈

| 领域 | 选择 | 理由与备选 |
|---|---|---|
| 桌面外壳 | electron，跟随最新稳定版的前一版（M0用44.10.0） | chromium三端表现一致；opencode今年4月因webkit渲染问题从tauri迁到了electron |
| ui | react 19+typescript+vite | 生态和招人 |
| 样式与组件 | css变量（设计令牌）加自建组件，组件自己补aria属性和键盘操作 | 少依赖、应用包更小；原计划的tailwind+radix没有引入（见16第1节） |
| 状态 | zustand管ui状态；线程事件流用自研订阅层 | 事件溯源配合按seq续传 |
| 长列表 | tanstack virtual | 万级事件的线程 |
| 编辑器与diff | monaco | 轻编辑和diff审阅共用 |
| 终端 | xterm.js 6+node-pty 1.2.0-beta.18 | node-pty正式版1.1.0缺linux预编译，1.2测试版带齐六个平台；node-pty放在外壳里，host按路径加载 |
| markdown与高亮 | react-markdown+shiki | |
| 国际化 | 自写的中英文词典，英文词典和中文同形，缺翻译是类型错误 | 文案不写死在代码里；不需要i18next的插件体系 |
| 协议与校验 | zod v4（可导出json schema、生成类型） | 备选typebox |
| 存储 | sqlite：node内置的`node:sqlite`（已核对electron 44可用，含fts5 trigram） | 单文件、全文搜索、免原生模块 |
| 引擎内核 | 自研：`packages/providers`（openai chat和anthropic messages两种wire、怪癖数据）加`packages/engine`的agent循环 | 见05第3节和16第1节 |
| acp | `@agentclientprotocol/sdk` 2.x | 官方sdk |
| mcp | `@modelcontextprotocol/client` 2.4.0 | 官方sdk的v2拆包；v1的`@modelcontextprotocol/sdk`已是维护线，不支持2026-07-28规范 |
| 沙箱 | `@anthropic-ai/sandbox-runtime`（mac、linux）；windows先靠策略兜底 | 见10 |
| 搜索 | 纯js遍历（遵守.gitignore），系统装了`rg`时优先用 | `@vscode/ripgrep`只下载本机平台的二进制，交叉打包拿不到另外五个平台 |
| 日志 | pino，带脱敏 | |
| 单仓与构建 | pnpm workspaces（`pnpm -r`）；界面用vite构建，bootstrap和host用esbuild | turborepo默认上传匿名使用数据，M0先不用，构建变慢后再评估 |
| 打包 | electron-builder（dmg/zip、nsis、appimage/deb） | 支持在mac上交叉打windows、linux包 |
| 测试 | vitest、@testing-library/react、playwright（electron模式） | 见13 |
| 更新与市场托管 | 静态文件（github releases加国内对象存储） | 不需要自建服务端，见12 |

## 3. 仓库结构

```
xora-code/
├─ apps/
│  ├─ desktop/        electron：bootstrap（main）、preload、修复模式页面、打包配置
│  └─ ui/             react渲染层（同一份代码以后可以作web端）
├─ packages/
│  ├─ protocol/       ui↔host协议：schema、类型、版本号
│  ├─ host/           线程、审批、worktree、审阅、调度、计量、扩展管理
│  ├─ workflows/      组织与名册、档位路由、任务看板与两本账、主管运行时、工作流与触发器
│  ├─ engine/         xora engine：acp服务端、agent循环、工具、子agent、压缩
│  ├─ providers/      供应商适配：协议、怪癖钩子、计价
│  ├─ tools/          文件、编辑、shell、搜索、web、git、浏览器工具
│  ├─ sandbox/        沙箱封装
│  ├─ mcp/            mcp客户端、oauth、注册表
│  ├─ extensions/     skills、插件、hooks、命令、场景agent的加载与校验
│  ├─ storage/        sqlite、事件日志、迁移、备份
│  ├─ updater/        槽位、清单验签、下载、回滚（bootstrap和host共用）
│  ├─ metering/       用量事件、计价、预算
│  ├─ ui-kit/         设计令牌与组件
│  └─ test-kit/       fake acp agent、mock模型服务、录制回放
├─ presets/           模型目录、价格、怪癖、场景agent、内置skills（数据，可在线更新）
├─ build/             打包、签名、清单生成、sbom
├─ docs/
└─ website/
```

依赖规则（ci里用依赖检查强制执行）：

- `protocol`不依赖任何包；`ui`只依赖`protocol`和`ui-kit`。
- `host`依赖`protocol`、`storage`、`providers`（只读目录与计价）、`metering`、`workflows`、`extensions`、`mcp`（只做配置管理）、`updater`。
- `engine`依赖`providers`、`tools`、`mcp`；不依赖`host`和`ui`，只通过acp通信。skills、命令和hooks由host处理：skill工具和工具前后的hook经`_xora/*`扩展方法回到host执行。
- `apps/desktop`的bootstrap只依赖`updater`，不依赖任何业务包。

## 4. 协议

### 4.1 ui↔host：产品协议

- json-rpc 2.0 over MessagePort，参照codex app-server的thread/turn/item模型。
- 方法分组：`project.*`、`thread.*`、`turn.*`、`approval.*`、`review.*`、`worktree.*`、`agent.*`、`task.*`、`workflow.*`、`provider.*`、`extension.*`、`usage.*`、`update.*`、`settings.*`。
- 事件格式`{threadId, seq, turnId, itemId, ts, kind, payload}`。订阅等于快照加从`seq`续传，断线后重新同步。
- 审批是host发给ui的反向请求，带一次性id和过期时间。
- ui和host在同一个应用包里发布，协议版本天然一致；以后开放远程访问时再做版本协商。
- 以后同一套协议经websocket+token开放给web端和手机。

### 4.2 host↔引擎：acp

- 按`initialize`返回的能力启用功能：`session/list`、`session/resume`、`session/close`、`session/set_config_option`、`usage_update`、elicitation、`$/cancel_request`。
- xora engine的私有能力走`_meta`和`_xora/*`扩展方法，包括检查点、子agent树、压缩状态、生效提示词、计量明细。外部agent没有这些能力时，界面相应降级。
- turn状态机：idle→running→cancelling→completed/cancelled/failed，以prompt响应的`stopReason`为准；晚到的事件按`turnId`丢弃。

### 4.3 引擎↔扩展

- mcp（stdio、streamable http）、hooks（命令或http）、skills（文件），见09。

## 5. 数据与存储

```
<数据目录>/   mac: ~/Library/Application Support/xora-code
              win: %APPDATA%\xora-code
              linux: ~/.config/xora-code
              （旧版0.2.x用的是"Xora Code"目录，新版故意分开，互不读写）
├─ app/           应用包槽位与state.json（见12）
├─ electron/      chromium的配置和缓存
├─ engines/       外部agent，按版本存放
├─ presets/       在线更新的预设数据，按版本存放
├─ extensions/    已安装的插件、skills、mcp配置
├─ prompts/       全局提示词（见08）
├─ data/
│  ├─ xora.db     sqlite：项目、线程、索引、设置、用量
│  ├─ threads/<threadId>/
│  │    events.v1.jsonl   界面事件日志（只追加）
│  │    attachments/      附件
│  │    artifacts/        完整的工具输出等大对象
│  └─ backups/    迁移前快照和定期快照
├─ worktrees/<projectId>/<threadId>/
├─ checkpoints/<projectId>/   影子git（见04）
└─ logs/
```

规则：

- 每个线程一个只追加的事件日志，每行带`seq`和crc。格式升级写`events.v2.jsonl`，旧文件不改。
- sqlite只存索引和设置，坏了可以从日志重建。
- 迁移前自动备份；同一大版本内只做加法迁移，保证回滚后旧版本还能读（见12）。
- 引擎自己的会话日志是模型上下文的来源（xora engine用自己的jsonl会话文件，压缩只记录上下文起点，不删原文），host的事件日志是界面时间线的来源，两者靠`turnId`关联。
- 本地存原文；密钥不进日志；导出和上报时再脱敏。
