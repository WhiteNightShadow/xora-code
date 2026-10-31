# 16｜M1～M4实施计划

- 日期：2026-10-30
- 状态：M1～M4的工作包已在`next`上实现（2026-10-30），进度和没做完的部分见第6节。本文把四个里程碑拆成工作包，并记录相对设计稿的调整。
- 分支：全部在`next`上开发，本地提交，推送和合并回`main`等用户确认。

## 1. 相对设计稿的调整

| 项 | 设计稿 | 调整为 | 理由 |
|---|---|---|---|
| 引擎内核 | pi（`@earendil-works/pi-ai`、`pi-agent-core`） | 自研wire层和agent循环，provider接口保持可替换 | pi-ai 1.4.0依赖openai、anthropic、google genai、aws bedrock四套sdk，会把每次热更新的应用包撑大好几mb；每周发版，出过不兼容改动。国产三家和其他目标厂商都能用openai chat和anthropic messages两种协议覆盖，自研两套wire层约一千多行，怪癖、用量映射、错误归类、录制回放都能自己掌控。以后需要时可以把pi-ai接成一个可选后端 |
| acp | `@agentclientprotocol/sdk` 2.x | 同，用2.1.0的v1稳定入口 | 已核对：v1稳定版已含`usage_update`、`notice`、`compaction_update`、`session/list`、`session/resume`、`session/close`。2.2.0是当天发布的，pnpm 12的最短发布时长检查会拦下；没有加例外，退回接口相同的2.1.0 |
| bootstrap的依赖 | 只依赖`updater` | `updater`，加上`protocol`的`shell`、`rpc`、`transport`三个子路径 | bootstrap要给host提供钥匙串、对话框、通知、防休眠、托盘、更新暂存等服务，这条通道也要做schema校验；只引入这三个文件，不带产品协议的其余部分 |
| 引擎和host的扩展点 | `_meta`和`_xora/*` | 同；另加host工具：host在会话配置里声明工具，引擎经`_xora/tool/call`回到host执行 | 主管的派工、等待、验收等工具要由host执行（host持有看板、worktree和预算），引擎只转发 |
| 界面样式 | tailwind v4+radix | css变量加自建组件 | 少依赖、应用包更小；组件自己补aria属性和键盘操作 |
| 存储 | 优先`node:sqlite` | 同 | 已核对：electron 44自带的node 24.22.1里`node:sqlite`可用，fts5全文搜索可用 |
| 搜索工具 | `@vscode/ripgrep` | 纯js实现，系统装了`rg`就优先用 | `@vscode/ripgrep`在安装时只下载本机平台的二进制，没法在mac上交叉打出另外五个平台的包 |
| 终端 | node-pty 1.2 | node-pty 1.2.0-beta.18（锁版本） | 已核对：正式版1.1.0没有linux预编译；1.2.0-beta.18带齐六个平台 |
| ui国际化 | i18next | 自写的轻量`t()`加中英文词典 | 只需要按键取文案，不需要i18next的插件体系 |
| mcp客户端 | `@modelcontextprotocol/sdk` | `@modelcontextprotocol/client` 2.4.0 | 官方v2拆包，已满7天；v1只到2025-11-25规范，是维护线。stdio传输自己写（要杀整棵进程树、拿退出码、不混入sdk的默认环境变量） |
| skills和hooks在哪执行 | 引擎 | host | host持有信任、密钥和项目状态；引擎只在会话配置声明了hook事件时，经`_xora/hook/run`在工具调用前后问host；skill索引作为提示词层下发，`skill`工具是host工具 |
| 扩展的用户目录 | `<数据目录>/skills/`等 | `<数据目录>/extensions/`下的`skills/`、`commands/`、`agents/`、`hooks.json`、`plugins/`、`state.json` | 数据目录根下保持整洁；`~/.agents/skills/`照旧读取 |
| 项目信任存放 | 信任文件 | 沿用projects表的`trusted`列 | M1已有这一列，不再多一份文件 |
| 检查点：回到第n轮、分叉 | 未定 | 引擎在会话文件里给每个host轮次记一个标记；“回到这一轮之前”追加一条回退记录（不删原文），可同时按轮倒序撤销文件；“从这一轮分叉”复制标记之前的会话记录成新会话，新线程带上保留轮次的时间线，同一目录时连检查点一起复制 | 和压缩一样只追加不删除，出问题能追查；只支持xora engine，外部引擎的线程只能按轮撤销文件 |
| 用对话创建扩展 | creator模式 | 内置skill `extension-creator`加普通的write工具 | 不另做一套流程：保存前的预览就是写文件的审批卡片；`extensions`包里的`plan*`函数留给以后的界面向导 |
| mcp服务器配置 | 未定 | 全局和项目级的配置存`state.json`，环境变量和请求头的值一律存系统钥匙串；仓库里的`.mcp.json`、`.xora/mcp.json`只读，项目受信后才启动 | 配置文件里不出现密钥；项目级配置不写进用户仓库 |

## 2. 新增的包

| 包 | 职责 | 里程碑 |
|---|---|---|
| `packages/storage` | sqlite（`node:sqlite`）、迁移、线程事件日志（jsonl，带seq和crc）、大对象存储 | M1 |
| `packages/providers` | 厂商预设（数据）、openai chat和anthropic messages两种wire、sse解析、怪癖、用量映射、错误归类、`/models`核对、连接测试 | M1、M2 |
| `packages/metering` | 价格表、阶梯与峰谷计价、预算判定、汇总 | M1、M2 |
| `packages/tools` | read、list、glob、grep、write、edit、apply_patch、bash、todo；路径策略；输出截断 | M1 |
| `packages/engine` | xora engine：acp服务端、会话存储、agent循环、权限桥接、提示词拼装、压缩、子agent、skills与mcp接入 | M1～M4 |
| `packages/workspace` | 影子git检查点、每轮diff、撤销、worktree、hunk操作 | M1、M3 |
| `packages/extensions` | skills、命令、hooks、claude插件与市场、信任 | M4 |
| `packages/mcp` | mcp客户端（stdio、streamable http、oauth）、配置导入 | M4 |
| `packages/workflows` | 组织、档位、名册、看板、两本账、主管运行时、质量门、自主级别 | M4 |
| `packages/test-kit` | mock模型服务（openai和anthropic两种sse）、fake acp agent | M1 |

依赖方向不变：`ui`只依赖`protocol`、`ui-kit`；`engine`不依赖`host`，只通过acp通信；bootstrap只依赖`updater`。

## 3. 工作包

### M1 核心闭环

| 编号 | 内容 | 落点 | 验收 |
|---|---|---|---|
| M1-1 | 产品协议：project、thread、turn、item、approval、review、provider、settings、prompt、usage、update | `protocol` | schema单测；ui和host两端都校验 |
| M1-2 | 存储：sqlite迁移、事件日志、断电后从日志重建索引 | `storage` | 单测：crc损坏行跳过、重建 |
| M1-3 | provider：deepseek、kimi、glm、openai兼容自定义；思考回传、tool_choice降级、采样白名单、用量映射、错误归类 | `providers` | 录制回放单测覆盖07第5节九条规则 |
| M1-4 | 工具集与路径策略 | `tools` | 单测：越界、符号链接、敏感文件、apply_patch |
| M1-5 | xora engine：acp会话new/load/resume/list/close、prompt、cancel；流式、并行只读工具；权限请求交给host | `engine` | 对mock模型服务的端到端单测 |
| M1-6 | host：线程状态机、引擎进程管理、审批与策略（四种模式、规则、路径边界）、设置、密钥 | `host` | 权限契约测试：每种模式下该问的都问到 |
| M1-7 | 每轮diff与撤销：影子git、按文件撤销带哈希校验 | `workspace` | 单测：撤销不覆盖用户后来的修改 |
| M1-8 | 主界面骨架：项目与线程侧栏、等我处理、线程流、composer、审批卡片、变更面板、设置（模型与密钥、提示词、权限） | `apps/ui` | 打包后的真实应用里走通一轮 |
| M1-9 | shell服务：钥匙串（safeStorage）、选目录、通知、防休眠、打开外部链接 | `apps/desktop` | 演练脚本覆盖 |
| M1-10 | 应用包热更新通道：更新源、下载、校验、交给bootstrap暂存、空闲时提示重启 | `host`、`apps/desktop`、`build` | 演练：从本地更新源升级，再回滚 |

### M2 模型与上下文

| 编号 | 内容 | 落点 | 验收 |
|---|---|---|---|
| M2-1 | 全部api厂商预设、本地模型探测、自定义端点、kimi code key直连 | `providers` | 预设schema校验；探测单测 |
| M2-2 | 外部acp引擎：注册表（codex、claude、kimi、gemini、opencode、qwen、grok）、能力降级、免审批开关 | `host` | fake acp agent契约测试 |
| M2-3 | 路由与回退：模型链，遇限速、过载、5xx切下一个；跨家族切换先摘要 | `engine` | 单测 |
| M2-4 | 提示词分层：系统、全局、组织、AGENTS.md层级、个人项目、agent、会话；查看生效提示词 | `engine`、`host` | 单测：拼装顺序、来源标注 |
| M2-5 | 四级压缩：写入时裁剪、旧结果清理、摘要压缩、换模型压缩；手动`/compact` | `engine` | 单测：两次压缩后任务继续 |
| M2-6 | 轨迹视图：每次请求的耗时、token、费用 | `host`、`ui` | 界面 |
| M2-7 | 用量与预算：各级汇总、预算暂停 | `metering`、`host`、`ui` | 单测：峰谷计价、预算 |

### M3 并行与审阅

| 编号 | 内容 | 落点 | 验收 |
|---|---|---|---|
| M3-1 | worktree：创建、上限、`.worktreeinclude`、setup脚本、`XORA_PORT`、hand off | `workspace`、`host` | 单测：3个worktree线程互不干扰 |
| M3-2 | 并行候选：同一任务多个模型各占一个worktree，对比后应用其中一个 | `host`、`ui` | 单测：应用后主目录正确 |
| M3-3 | 检查点：回到第n轮（文件加对话，或只回文件）、从第n轮分叉 | `workspace`、`engine`、`host` | 单测 |
| M3-4 | hunk审阅：按hunk暂存、还原；行评论攒批发给agent | `workspace`、`ui` | 单测 |
| M3-5 | 终端：node-pty加xterm | `apps/desktop`、`host`、`ui` | 手动 |
| M3-6 | 浏览器预览与标注 | `apps/desktop`、`ui` | 手动 |
| M3-7 | 文件预览、通知、托盘、防休眠、并排查看、goal模式 | 多处 | 手动加单测 |

### M4 扩展与agent团队

| 编号 | 内容 | 落点 | 验收 |
|---|---|---|---|
| M4-1 | skills：发现、渐进加载、信任 | `extensions`、`engine` | 单测 |
| M4-2 | 命令与hooks：九个事件、命令和http两种handler、超时与失败策略 | `extensions`、`engine` | 单测：不受信仓库默认不执行 |
| M4-3 | mcp：stdio、streamable http、oauth 2.1加pkce；导入claude、cursor、codex配置 | `mcp`、`engine` | 对本地mcp服务的单测 |
| M4-4 | claude插件与市场：解析、安装、启用、锁版本 | `extensions`、`host` | 能装一个claude插件并使用 |
| M4-5 | 用对话创建扩展（creator） | `engine`、内置模板 | 手动 |
| M4-6 | 组织、档位与模型链、名册、三层提示词 | `workflows` | 单测 |
| M4-7 | 主管-执行全流程：澄清、侦察、规划、计划评审、派工、执行、验收、退回与升档、整合、交付报告 | `workflows`、`engine`、`host` | 对mock模型服务的端到端：拆出多个任务、验收不过退回或升档、交付报告与花费正确 |
| M4-8 | 看板、两本账、质量门、自主级别、团队视图 | `workflows`、`ui` | 单测加界面 |
| M4-9 | 行内编辑、lsp诊断上下文 | `ui`、`host` | 手动 |

## 4. 顺序

1. 先定接口：协议、provider的消息格式、工具接口。
2. 叶子包并行做：`providers`和`test-kit`、`tools`、`metering`。
3. 主干：`storage`→`engine`→`host`→bootstrap的shell服务→界面，打通M1闭环。
4. 在M1闭环上依次叠加M2、M3的worktree与检查点、M4的团队核心、M4的扩展，最后补M3的终端、预览等界面能力。

每完成一层就跑类型检查、单测和演练；不达标不往下走。

## 5. 本轮不做

- 真实厂商端点的抽样测试：需要用户自己的key，留作手动触发。
- windows、linux实机冒烟：测试机和pabox共用，等用户确认空闲。推送`next`后CI已在windows-2025和ubuntu-24.04上跑全部测试（含host和engine的端到端测试），10-30修掉windows上的几处问题后三个系统全绿；修的是：事件日志用追加句柄截断报EPERM、powershell的进度记录以CLIXML混进命令输出、mcp找不到命令时报成connect-failed。electron应用本身（冒烟、演练）在windows、linux上还没跑过。
- 合并回`main`：等用户确认（`next`已于10-30推送）。
- 1.0之后的项（见14第2节）。

## 6. 进度（2026-10-30）

全部在`next`上提交，10-30已推送到origin。验证方式：全仓单测和端到端测试（1026个通过、3个按平台跳过）、类型检查、biome；开发构建和mac arm64安装包各跑一遍界面冒烟（14步）和更新演练（开发构建9项、安装包8项）。

| 工作包 | 状态 | 说明 |
|---|---|---|
| M1-1～M1-10 | 完成 | 冒烟覆盖“连接模型→审批→改文件→看diff→撤销”；演练覆盖热更新、坏包回滚、篡改校验、在线更新、修复模式 |
| M2-1 | 完成 | 真实厂商端点没测（需要用户的key）；本地模型探测只用mock测过 |
| M2-2 | 完成 | 外部引擎的启动命令没在真机核对 |
| M2-3～M2-7 | 完成 | |
| M3-1、M3-2、M3-4、M3-7 | 完成 | |
| M3-3 | 完成 | 回到第n轮（对话加可选的文件）、从第n轮分叉；只支持xora engine |
| M3-5 | 完成 | 冒烟里在打包后的应用中跑过终端命令 |
| M3-6 | 完成 | 冒烟里打开过本地页面；截图和圈选标注要窗口在屏幕上，只手动 |
| M4-1、M4-2 | 完成 | hooks接了7个事件，SubagentStop、SessionEnd、Stop的“继续工作”还没做 |
| M4-3 | 完成 | oauth只对测试里的授权服务器跑过；windows、linux的进程树清理没实机验证 |
| M4-4 | 完成 | 插件安装、启用、卸载、锁版本，市场支持git和本地目录；内置官方市场、npm等来源没做 |
| M4-5 | 完成 | 内置skill `extension-creator`；插件和工作流的向导没做 |
| M4-6～M4-8 | 完成 | 见06第18节；团队视图在真实应用里只走了“启动→停止”，完整一轮只在host端到端测试里跑 |
| M4-9 | 完成 | 行内编辑；lsp工具（诊断、定义、引用、悬停、符号）和改完文件后附上新错误，见04、08。只用本机的clangd实测过，typescript、python、go、rust的语言服务器没实际跑过 |

**另外发现并修掉的问题**：开着预览关窗口时应用退不出去（shell的退出清理会抛错）；“查看生效提示词”看不到团队和skills层。

**钥匙串**：1.0用自己的钥匙串项“xora-code Safe Storage”，不碰旧版0.2.x的“Xora Code Safe Storage”，从0.2.x升级不会再弹授权框。electron按主脚本加载完时的`app.name`给这一项取名，所以shell一启动就把`app.name`设成`xora-code`，到`will-finish-launching`再改回“Xora Code”，菜单和窗口用的是改回后的名字。这个时机依赖electron的`PostCreateMainMessageLoop`，升级electron时要复查。已在开发构建上用注入的探测库核对过：启动加一次加密，只请求了“xora-code Safe Storage”，调用被探测库拦下，真实钥匙串里没有生成这一项。冒烟和演练仍带Chromium的`--use-mock-keychain`，不碰真实钥匙串；冒烟还会检查启动后`app.name`已经改回。

**安装包加固（10-30）**：
- `electronLanguages`只留中英文语言包，mac arm64的dmg从128mb降到117mb，装好后从317mb降到270mb。
- 打开electron fuses（见10第6节）。xora engine改由shell用utility process启动、经MessagePort和host通信之后，`RunAsNode`也关掉了：安装包不能再被当成node运行。
- 修复模式页面从`file://`改走`xora://safe-mode/`：关掉`file://`的额外权限后，chromium读不到app.asar里的文件，演练时发现修复模式页面打不开。
- host和引擎启动时加载系统证书库，代替不再生效的`NODE_EXTRA_CA_CERTS`。
- 在mac arm64安装包上核对过：fuses状态、ad-hoc签名、Info.plist里的asar完整性；更新演练8项、界面冒烟14步都通过；主进程不再接受`--inspect`。

**还要核对**：windows上关掉`RunAsNode`后`child_process.fork`会报错，node-pty关终端时的fork会失败；host已改成先用`taskkill /T`结束终端的进程树，没在windows实机上跑过。
