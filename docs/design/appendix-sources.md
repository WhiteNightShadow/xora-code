# 附录：调研来源与核对记录（2026-10-29）

下面的事实都已回到原始来源核对过。设计文档里标"未核实"的内容不在此列。

## 平台与协议

| 事实 | 来源 |
|---|---|
| electron 39于2026-05-05停止维护，42于2026-10-20停止维护，43支持到2027-01-05，45支持到2027-04-27 | [endoflife.date/electron](https://endoflife.date/electron) |
| acp已稳定的能力：`session/list`（02-18）、`session/resume`（04-22）、`session/close`（04-23）、`usage_update`和`session/delete`（06-05）、`$/cancel_request`（06-29）、elicitation（07-22）、tool call name（09-17）；v2草案于07-20发布 | [acp updates](https://agentclientprotocol.com/updates) |
| config options取代session modes；设置方法是`session/set_config_option`，类别有mode、model、model_config、thought_level | [acp session config options](https://agentclientprotocol.com/protocol/session-config-options) |
| `@agentclientprotocol/sdk`最新版本2.1.0（10-28） | npm registry |
| theia 1.74升级到electron 42；1.75移除webpack；1.77（未发布）计划升级到electron 44 | [theia changelog](https://raw.githubusercontent.com/eclipse-theia/theia/master/CHANGELOG.md) |

## grok build

| 事实 | 来源 |
|---|---|
| npm上`@xai-official/grok`的latest为1.0.70（10-23），alpha为1.0.73（10-28）；0.2.102发布于07-16，1.0.0发布于08-07 | npm registry |
| 0.2.102没有list/resume/close/config options；上游开源代码到1.0.45（09-29）已全部支持 | grok build源码（`acp_agent.rs`） |
| 遥测默认关闭但可由远端设置开启；`GROK_TELEMETRY_ENABLED=0`可以强制关闭；0.2.102里对话正文上传是空实现 | grok build 0.2.102源码（`agent/config.rs`、`upload/trace.rs`、`xai-grok-telemetry`） |
| 2026-07曾发生整仓库上传事件，后来被服务端开关`disable_codebase_upload`停掉 | [the register](https://www.theregister.com/a/5271123) |

## 引擎候选

| 事实 | 来源 |
|---|---|
| pi：`earendil-works/pi`，mit，1.4.0（10-21），node≥22.19；pi-ai内置deepseek、kimi-coding、moonshotai-cn、zai-coding-cn等provider，并有`thinkingFormat`、`requiresReasoningContentOnAssistantMessages`、`zaiToolStream`、`maxTokensField`等兼容开关 | github api、npm registry、[compat-schema.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/compat-schema.ts) |
| pi-telemetry本身不带上报器；coding-agent的安装统计由`PI_TELEMETRY`或设置项控制 | pi源码 |
| opencode：`anomalyco/opencode`，mit，1.19.5（10-28）；04-19从tauri迁到electron，原因是webkit渲染慢、样式不一致、cli启动偶发失败 | github api、npm registry、[迁移说明](https://dev.to/brendonovich/moving-opencode-desktop-to-electron-4hip) |
| codex 0.165.0（10-27）；`wire_api`只支持`responses` | npm registry、[codex配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) |
| kimi-cli（python）已归档，由mit许可的kimi-code接替；goose迁到`aaif-goose/goose` | github api |
| `@anthropic-ai/sandbox-runtime` 0.0.81，apache-2.0 | npm registry |
| deepseek harness：`deepseek-ai/deepseek-harness`，mit，2026-08-13创建；cordis插件架构；electron以node模式启动本地host；会话是只追加、按版本命名的事件日志 | github api、[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) |

## 国产模型

| 事实 | 来源 |
|---|---|
| deepseek：模型为`deepseek-flash`（v4.1 flash）和`deepseek-v4-pro`，1m上下文，最大输出384k；价格与峰谷规则；search/fetch从11-01起收费 | [deepseek定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) |
| deepseek：带tools时必须完整回传`reasoning_content`，否则报400；思考模式默认开启 | [deepseek思考模式](https://api-docs.deepseek.com/guides/thinking_mode) |
| glm coding plan只能在23个指定工具里使用，xora不在名单上 | [智谱coding plan工具](https://docs.bigmodel.cn/cn/coding-plan/tool/others.md) |
| kimi code：禁止伪装或篡改客户端身份，订阅只用于个人交互式使用，第三方工具名单不是穷举 | [kimi code社区规范](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html) |

调研agent提供、但没有逐条复核的细节（kimi的采样锁定、glm的积分公式、各家错误码等），原始链接见对应的厂商文档：[kimi思考模型](https://platform.kimi.ai/docs/guide/use-thinking-models.md)、[kimi code模型配置](https://www.kimi.com/code/docs/en/kimi-code/models.html)、[glm coding plan概览](https://docs.bigmodel.cn/cn/coding-plan/overview)、[glm思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode.md)、[glm错误码](https://docs.bigmodel.cn/cn/api/api-code.md)。

## 对标产品与grok bot

| 事实 | 来源 |
|---|---|
| cursor agents window：agent优先的统一工作台，跨工作区管理；多个agent并行；环境有local、cloud、remote ssh；local和cloud之间hand off；新的diffs视图 | [cursor agents window](https://cursor.com/docs/agent/agents-window) |
| cursor `/best-of-n`让每个模型各占一个worktree，不会自动合并；`/apply-worktree`、`/delete-worktree`；整机默认最多25个worktree，定时清理；`.cursor/worktrees.json`配置setup脚本 | [cursor worktrees](https://cursor.com/docs/configuration/worktrees) |
| deepseek harness官网：桌面版只提供macos（apple silicon）和windows（64位）；侧栏有新会话、插件、自动化、工作区；轨迹视图；定时任务；creator mode用对话生成插件；agent teams和subagents插件；"@ files or sessions"；也面向非编程的日常任务 | [deepseek harness官网](https://deepseek.com/en/harness/) |
| grok build的dashboard按等待输入、进行中、已完成给会话分组 | [grok build dashboard](https://docs.x.ai/build/features/dashboard) |

grok bot的官方文档没能检索到，下面的描述来自第三方报道，没有和官方核对：2026-08-11开放beta；bot有名字、职责和说明，带各自的记忆、skills和routine；bot之间可以在群聊里交接任务；所有bot共用账户下的一台云端机器；审计视图和专门的花费上限都还没有提供；不支持linux桌面。来源：[datacamp](https://www.datacamp.com/blog/grok-bot)、[composio](https://composio.dev/content/guide-to-frok-bot)。

## 多agent团队调研（2026-10-30）

star数来自github api（2026-10-30）。

| 事实 | 来源 |
|---|---|
| claude code agent teams：主管加队友；共享任务列表（三态、依赖、文件锁认领）；邮箱；队友可以先出计划；TaskCreated、TaskCompleted、TeammateIdle钩子；其他agent的消息不能代替用户批准；建议3～5个队友、每人5～6个任务、按文件分工；不能嵌套团队 | [claude code agent teams](https://code.claude.com/docs/en/agent-teams) |
| oh-my-openagent：主agent经`task`按类别委派；每个类别有模型链、技能和`prompt_append`；explore、librarian用快模型且只读；plan-consultant、plan-reviewer用不同家族的强模型；类别worker不能再委派；deep-low可以返回`ESCALATE: deep-high`升档；"一个目标、一个交付"；AGENTS.md是上下文，不是权限边界 | [features reference](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md) |
| magentic-one：任务账本（事实、猜测）加进度账本；外环和内环；多步没进展时重新规划；编排者建议用强推理模型 | [magentic-one文档](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html) |
| aider architect模式：architect模型出方案，editor模型落成编辑；推荐强推理模型做architect；会多一次请求 | [aider chat modes](https://aider.chat/docs/usage/modes.html) |
| openai agents sdk："agent作为工具"和"交接"的区别；链式、并行、评审循环 | [multi-agent](https://openai.github.io/openai-agents-python/multi_agent/) |
| crewai：hierarchical流程由manager负责规划、分派、验收，任务不预先分配 | [crewai processes](https://docs.crewai.com/en/concepts/processes) |
| task master：从prd拆任务、复杂度分析、展开子任务；模型分main、research、fallback | [claude-task-master](https://github.com/eyaltoledano/claude-task-master) |
