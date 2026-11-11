# 09｜扩展生态

## 1. skills

- **格式**：采用agent skills开放格式，一个目录加一份`SKILL.md`（frontmatter里写name和description）。和claude code、codex、opencode通用。
- **发现顺序**：
  1. 项目：`.xora/skills/`、`.agents/skills/`、`.claude/skills/`
  2. 用户：`<数据目录>/skills/`、`~/.agents/skills/`
  3. 插件
  4. 内置
- **渐进加载**：启动时只把name和description放进上下文，用到时再读全文和附带文件。
- **管理**：可以查看列表、启用或停用，能看到来源、版本、信任状态。项目里的skills如果来自不受信的仓库，需要确认后才能用。

## 2. mcp

- **传输**：
  - 支持stdio和streamable http。
  - sse已被acp v2草案和mcp新规范弃用，只做兼容读取。
- **远程认证**：oauth 2.1加pkce，令牌存系统钥匙串。
- **能力**：tools、resources、prompts、elicitation。mcp apps（带界面的mcp）以后再评估。
- **配置**：
  - 分全局和项目两级。
  - 可以导入claude code、cursor、codex、vs code的mcp配置。
- **诊断**：
  - 沿用旧版的三态（未启动、运行中、失败），加上日志和一键重启。
  - 可以按工具允许或禁用；单次输出有大小上限。
- **发现**：官方mcp registry和市场。
- **引擎接入**：xora engine自己做mcp客户端；外部acp agent通过session/new的`mcpServers`下发配置。

## 3. 插件与市场

- **插件**：一组能力的打包，可以包含skills、场景agent、mcp服务器、hooks、命令、模型预设、提示词模板。
- **格式**：
  - 兼容claude插件（`.claude-plugin/plugin.json`）和市场清单（`marketplace.json`）。grok等工具也已经能直接加载claude插件。
  - xora专有字段放在`xora`键下。
- **市场**：
  - 内置官方市场，用户也可以添加git或http市场。
  - 每个插件显示来源、版本、所需权限（会运行哪些命令、访问哪些域名）、信任状态。
- **安装**：下载→校验哈希（签名可选）→展示权限→用户确认→启用。可以锁版本、回滚，自动更新可开关。
- **用对话创建**（对应deepseek harness的creator模式）：描述需求，生成skill、场景模板、工作流或插件草稿，预览权限后保存。
- **界面贡献**：1.0不开放任意界面插件，只允许声明式贡献，即命令、场景、设置项。

## 4. hooks与命令

- **事件**：沿用claude code和codex的命名：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PreCompact、Stop、SubagentStop、Notification、SessionEnd。
- **handler**：
  - 可以是命令（shell，经沙箱）或http。
  - 可以返回允许、拒绝或修改。
  - 有超时和失败策略。
- **信任**：不受信仓库里的项目hooks默认禁用（grok 1.0.63/64也做了同样的收紧）。
- **命令**：`/`命令来自markdown文件，放在项目的`.xora/commands/`、用户目录或插件里，支持参数。

## 5. 信任模型

| 来源 | 默认状态 | 说明 |
|---|---|---|
| 内置 | 启用 | 随应用包一起签名 |
| 用户目录 | 启用 | 用户自己放进去的 |
| 项目（已信任的仓库） | 启用 | 在设置的扩展页信任（工作流看板顶部的提示2026-11-11随看板去掉，见06第31节；没有做打开项目时弹窗确认） |
| 项目（未信任的仓库） | hooks和mcp禁用；skills只读不执行脚本 | 信任后再启用 |
| 市场 | 安装时确认权限 | 更新时如果权限变多，要重新确认 |

修复模式（见12）可以一键禁用全部扩展，再逐个启用排查。

## 6. 首批常用清单

**内置skills**（随应用包发布，可以停用）：

| skill | 作用 |
|---|---|
| git工作流 | 分支、提交信息、变基与冲突处理的约定 |
| pr描述 | 按改动生成pr标题和说明 |
| 测试运行 | 识别项目的测试命令，失败时先读报错再改 |
| 代码审查清单 | 正确性、安全、性能、可读性的检查项 |
| 文档写作 | readme、设计文档、变更日志的结构 |
| 项目初始化 | 扫描仓库生成`AGENTS.md` |

**市场预置的mcp**（一键安装，默认不启用）：

| 类别 | 用途 |
|---|---|
| 代码托管 | github、gitlab的issue、pr、ci状态 |
| 浏览器自动化 | 网页操作与截图（内置预览之外的独立浏览器） |
| 文档检索 | 第三方库的最新文档 |
| 数据库 | postgres、mysql、sqlite的只读查询 |
| 抓包与接口 | 抓包工具、浏览器环境类mcp |
| 逆向分析 | jadx、ghidra、ida等 |
| 远程主机 | ssh执行（默认逐条询问） |
| 设计稿 | figma等设计工具 |

**首次启动导入**：扫描本机claude code、codex、cursor里已配置的mcp和skills，列出来让用户勾选导入。默认不启用，也不复制其中的密钥，密钥由用户重新填写或从钥匙串引用。

## 7. 实现落点（2026-10-30）

- **目录**：
  - 用户：`<数据目录>/extensions/`下的`skills/`、`commands/`、`agents/`、`hooks.json`、`plugins/`；`~/.agents/skills/`。
  - 项目：`.xora/skills/`、`.agents/skills/`、`.claude/skills/`；`.xora/commands/`、`.claude/commands/`；`.xora/agents/`、`.claude/agents/`；`.xora/hooks.json`、`.claude/settings.json`里的`hooks`；`.mcp.json`、`.xora/mcp.json`。
  - 开关和mcp服务器配置在`<数据目录>/extensions/state.json`；mcp的环境变量和请求头的值、oauth令牌都在系统钥匙串。
- **信任**：用户目录和内置的直接启用；项目的hooks、mcp服务器、skill脚本要项目受信；插件安装后默认停用，界面展示权限、用户确认后才启用，升级时权限变多会重新停用。
- **skills**：会话的提示词末尾放一层skills索引（id和一句描述），模型用`skill`工具读全文和附带文件；未受信项目的skill标注“只读，不运行脚本”。
- **命令**：`/名字 参数`在host里展开成命令文件的内容再发给模型，时间线里保留用户原来输入的文字；`/compact`是内置命令，不会被覆盖。
- **hooks**：
  - 九个事件都已接：SessionStart（新会话）、UserPromptSubmit（可拦截、可补充上下文）、PreToolUse（可拦截、改参数、要求确认或免确认）、PostToolUse（反馈追加到工具结果）、PreCompact、Stop、SubagentStop、Notification（出现审批卡片时）、SessionEnd。
  - PreCompact在手动`/compact`之前和引擎自己压缩之前（上下文快满、换到别家模型）运行，`trigger`是`manual`或`auto`，匹配器按它匹配。
  - Stop在agent结束这一轮时运行，host等它跑完再结束这一轮。hook返回`{"decision":"block","reason":"…"}`或退出码2时，reason作为下一条消息让agent在同一轮里接着做，再运行时`stop_hook_active`是true，一轮最多接着做3次；`continue: false`优先。payload带`last_assistant_message`。因为输出上限、请求上限结束的轮次也运行Stop，但不会接着做。
  - SubagentStop代替Stop用在团队成员（执行者、审查等）的线程上，匹配器按agent类型（如`coder`）或角色（如`executor`）匹配，payload带`agent_id`、`agent_type`、`task_id`，同样可以让成员接着做。
  - SessionEnd在线程删除、归档和应用退出时运行，`reason`是`delete`、`archive`或`app_exit`，匹配器按它匹配；尽力而为，最多等1.5秒。应用退出时靠host进程收到`SIGTERM`后再跑，windows上进程被直接结束时不保证。
  - 匹配用claude code的工具名（`Bash`、`Edit|Write`等），也认xora自己的工具名；`tool_input`里同时给出`file_path`这类claude的字段名。
  - hook的“免确认”不越过拒绝规则、工作区外路径、敏感文件和高风险动作（见06第18节）。
  - 外部acp agent自己压缩上下文时不触发PreCompact，它们的工具调用也不经过PreToolUse和PostToolUse。
- **市场**：兼容claude插件市场（`.claude-plugin/marketplace.json`），可以添加git地址（克隆到`<数据目录>/extensions/markets/`）或本地目录，在设置里浏览并安装；npm、压缩包等来源暂不支持，内置的官方市场还没有。
- **用对话创建**：内置skill `extension-creator`（启动时写到`<数据目录>/extensions/builtin/skills/`）告诉agent各类扩展的格式和存放位置；agent起草后用普通的write工具保存，写入前审批卡片会展示每个文件的内容。目前覆盖skill、命令和agent定义，插件和工作流还没做。
- **mcp**：xora engine按会话启动mcp服务器（工具名`mcp__服务器__工具`，每次调用都走权限策略）；外部acp agent经`session/new`的`mcpServers`拿到同一份配置。引擎在建立或恢复会话时把各服务器的状态带回host：启动失败的在时间线上提示一次，设置页显示引擎报告和手动测试里较新的那个结果。

