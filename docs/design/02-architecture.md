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
        │ acp（json-rpc：xora engine走MessagePort，外部agent走stdio）
        ▼
[引擎]  xora engine（utilityProcess，由bootstrap启动） | 外部acp agent（子进程：codex、claude、kimi code、opencode、grok、dsh …）
        │ https
        ▼
[模型]  api · 订阅 · 本地
```

要点：

- **bootstrap要小**：它是唯一不能热更新的js，目标在2000行以内，只做启动、回滚、修复和系统集成。业务逻辑全部放在可热更新的应用包里。
- **代码位置**：
  - ui、host、xora engine都在应用包里。
  - preload和原生模块（node-pty）在shell里。原生模块和electron abi绑定，应用包的清单要声明自己需要的abi。
- **引擎启动方式**：xora engine是electron的utility process，用的是electron自带的node，不用另外打包node，安装包也就能关掉`RunAsNode`这根fuse（见10第6节）。
  - utility process只有主进程能fork，所以host用`shell.engine.start`请bootstrap启动。bootstrap只启动它正在用的应用包里的`engine/index.cjs`，再建一对MessagePort，一端交给引擎，一端直接交给host，acp消息不经过主进程。
  - 引擎的stdout、stderr和退出由bootstrap转告host；崩溃检测、下次用到时重启仍由host负责。host重启或应用退出时，bootstrap结束这个host的全部引擎。
  - 不在electron里时（测试、单独用node跑host），host用自己的node经stdio启动引擎。外部agent一直是子进程，走stdio。
- **进程生命周期**：
  - 窗口关了任务继续跑（托盘常驻）。
  - host崩溃时由bootstrap重启，并从日志恢复线程状态。
  - 引擎崩溃只影响它所在的项目。
- **引擎进程粒度**：默认每个项目一个，进程内跑多个会话（acp本来就支持）。worktree线程靠session的`cwd`区分。

## 2. 技术栈

| 领域 | 选择 | 理由与备选 |
|---|---|---|
| 桌面外壳 | electron，跟随最新稳定版的前一版（M0用44.10.0） | 自带node和chromium，三端渲染一致；候选比较见2.1 |
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

### 2.1 为什么用electron

原来这里只有一行理由。2026-10-30把主要候选逐个比较了一遍，结论仍是electron。

比较以这几条约束为准：

1. host和引擎是typescript，跑在node上；acp、mcp的sdk和终端用的node-pty都属于node生态。换成哪个框架，这两个node进程都还在。
2. 界面是react网页，diff、终端、markdown都靠浏览器内核渲染。渲染快不快、三个系统上一不一样，直接影响体验。
3. 预览面板要嵌入可控制的网页，还要能截图和标注。
4. 没有长期可用的windows、linux实机，所以三端表现一致很重要。
5. 跟框架有关的只有shell层`apps/desktop`，约2000行；ui、host、引擎约2万行，换框架不用动。

| 候选 | 要改什么 | 好处 | 问题 |
|---|---|---|---|
| electron（现用） | 不用改 | 自带chromium和node，三端渲染一致；预览、截图、钥匙串、utility process都有现成接口；codex桌面版、vs code、cursor都用它 | 体积大：mac的dmg约128mb，装好后317mb，其中electron占287mb（去掉多余语言包后见下）；内存占用高 |
| tauri 2 | shell用rust重写；host和引擎另带一个node（压缩后约37mb，装好后116mb）；预览和截图按系统分别实现 | 框架本身小、内存低、权限模型好，还能做移动端 | mac和linux上是webkit，渲染慢、样式不一致，opencode就是因此迁走的；有项目反映linux上的webkitgtk很吃cpu；带上node后体积只省一半左右；官方的chromium内核（cef）运行时还没发布 |
| electrobun | 主进程跑在bun上，node-pty这类原生模块能不能用要先验证；shell重写 | 仍然是typescript；安装包和增量更新都很小 | 2026年2月才出1.0；文档建议linux版打包cef，体积又回到electron的水平；用的人少 |
| wails v3 | 后端换成go，或者也另带node | 体积小 | 还在beta；webkit的问题同样存在 |
| flutter | 界面全部重写，终端、diff、markdown换成dart生态的替代品 | 三端表现一致 | 重写量最大，node部分仍要另带 |
| 原生界面（swiftui、winui、gtk）或zed的gpui | 每个系统各写一套界面，或者全部改用rust | 体验和内存最好 | 工作量是现在的好几倍 |

结论：

- 核心本来就跑在node上。同时自带node和统一chromium的成熟方案只有electron；换tauri还得另带node，体积优势只剩一半左右，还多一层进程间通信。
- 界面大量依赖网页渲染，webkit在性能和样式上的差异是实际问题。openai也说过，codex桌面版选electron是为了支持windows和linux。
- M1～M4已经在electron上跑通了冒烟、演练和打包。

缺点的缓解（2026-10-30已做）：

- **体积**：只留中英文语言包（`electronLanguages`），mac arm64的dmg从128mb降到117mb，装好后从317mb降到270mb。日常更新只换几mb的应用包，不用重新下载electron。
- **安全**：打开electron fuses，见10第6节。
- **内存**：host和引擎本来就是独立进程；界面里的面板用到时再加载。

重新评估的时机：tauri正式发布chromium内核并且稳定下来；安装包体积或内存成了用户的主要抱怨；要做移动端。到那时只需重写约2000行的shell层。

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
