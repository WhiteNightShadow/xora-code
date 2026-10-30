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
| 项目（已信任的仓库） | 启用 | 第一次打开项目时确认信任 |
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
