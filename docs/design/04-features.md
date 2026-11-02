# 04｜功能重构

## 1. 项目与线程

- **项目**：一个目录（通常是git仓库），可以附加其他目录。
- **线程**：
  - 标题用快速模型自动生成。
  - 可以重命名、置顶、归档、搜索、导出（markdown或json）。
- **执行位置**：本地或worktree。ssh远程和云端放在1.0之后。
- **worktree**：
  - 放在`<数据目录>/worktrees/<projectId>/<threadId>`，用detached head，不污染仓库目录。需要提pr时再建`xora/<slug>`分支。
  - 支持hand off：线程可以在本地和worktree之间迁移，未提交的改动一起带过去。
  - 默认最多15个，删除前先做快照。
  - 项目级配置：
    - `.worktreeinclude`：要带进worktree的未跟踪文件，比如`.env`，首次带入需要确认。
    - setup脚本。
    - 每个worktree分配独立端口（环境变量`XORA_PORT`）。
  - worktree隔离不是安全边界，安全靠10。
- **冲突提示**：多个本地线程同时改同一个文件时给出提示。
- **并行候选**（对应cursor的`/best-of-n`）：同一个任务选2～4个模型，各开一个worktree并行做；完成后对比diff、测试结果和花费，选一个"应用到主目录"（对应`/apply-worktree`），其余删除。
- **兼容配置**：可以读取`.cursor/worktrees.json`里的setup脚本，减少迁移成本。

## 2. 对话与composer

- 引用：@文件、@符号、@诊断、@终端输出、@线程、@网址。
- 附件：图片、pdf、文本文件；粘贴长文本时自动转成附件。
- 控制：排队、运行中插话、停止、编辑上一条重新发送、从任一轮分叉。
- 选择：模式（询问、自动编辑、计划、全权）、模型、思考强度，在输入框下面。模式立即生效：运行中接下来的调用按新模式判断，等着审批的调用也重新判断；计划模式的提示词从下一轮起变。模型和思考强度从下一轮起生效。新线程默认用最后一次选的模式。
- /命令：内置命令（`/compact`、`/model`、`/review`等），加上来自扩展的命令（见09）。

## 3. 工具集

以下是xora engine内置的工具。外部agent用它们自己的工具，审批同样走host。

| 工具 | 说明 | 默认权限 |
|---|---|---|
| read、list、glob、grep | 读文件、列目录、按模式找文件、ripgrep搜索 | 放行 |
| edit、write、apply_patch | 精确替换、写文件、兼容codex的patch格式 | 询问；自动编辑模式下放行 |
| bash | 在pty里执行，支持超时和后台任务；输出过长时截断，完整输出存为artifact | 询问；只读命令白名单放行 |
| web_fetch、web_search | web_fetch抓http(s)网页：html转成markdown（有main或article时只取它们，去掉脚本、样式和导航），json格式化，其他文本原样，图片、pdf等二进制文件不读；一次最多返回约2万字符，更长的整篇存为artifact，可以用read、grep看，或带start接着取；拒绝本机和内网地址（跳转后的地址也查）和带账号密码的网址。web_search不用key：先查bing rss，失败、没有结果或结果跟查询不沾边时改查duckduckgo。还没做：配置的搜索api、厂商的服务端搜索工具 | 按域名询问；全权模式下放行 |
| browser | 驱动内置预览：打开、截图、点击、读dom、看控制台 | 询问 |
| git | status、diff、log、commit、branch；危险操作单独询问 | 只读部分放行 |
| lsp | 诊断、定义、引用、悬停、符号（见下面的“语言服务器”） | 放行 |
| todo、plan | 待办与计划 | 放行 |
| agent | 委派子agent（见下面的“子agent”） | 放行；子agent自己的工具调用照常审批 |
| ask_user | 中途向用户提问（elicitation） | — |
| mcp工具 | 按服务器和工具配置 | 按规则 |

### 语言服务器

- **支持的语言**：typescript/javascript用typescript-language-server，python用pyright（或basedpyright），go用gopls，rust用rust-analyzer，c/c++用clangd。xora不自带，按扩展名选服务器：受信项目先找项目里的`node_modules/.bin`，再找`PATH`；都没有时，结果里说明该装哪个。
- **生命周期**：按（根目录，语言）懒启动，同一根目录下的会话共用；10分钟没人用就停掉；引擎退出时连子进程一起杀（posix杀进程组，windows用`taskkill /T`）。5分钟内崩溃3次就先不再重启。
- **lsp工具**：`diagnostics`（一次最多10个文件）、`definition`、`references`、`hover`、`symbols`（文件大纲；带`query`时搜整个工作区）。行列号从1开始，也可以用`symbol`代替列号。只看工作区里的文件，路径相对工作区显示，输出有长度上限。
- **改完文件后的诊断**：edit、multi_edit、write、apply_patch成功后，把新内容同步给对应的服务器（装了但没在跑就启动），最多等1.5秒，把这次改动新增的错误和少量警告附在工具结果后面（以`LSP diagnostics after the edit`开头）；服务器第一次见到这个文件时列出它的全部错误。默认开，设置→模型与供应商里可以关；没装服务器时什么都不做。
- **安全**：会执行项目代码的情况要求项目受信：项目`node_modules/.bin`里的服务器只在受信项目里用；项目里有自己的typescript时（typescript-language-server会加载它），不受信的项目不启动；不受信的项目里rust-analyzer关掉build script和过程宏。

## 4. 审阅、检查点与回滚

- **检查点**：每轮开始前给工作区做影子git快照。用独立的`GIT_DIR`，执行`git add -A`后`write-tree`，不碰用户仓库的index和分支。
- **变更面板**：
  - 按轮、按文件、按分支三种视图。
  - 用真diff（jsdiff的`structuredPatch`）。
  - hunk级暂存和还原；行评论作为下一轮的prompt发出。
- **回滚**：
  - 回到第n轮：文件加对话一起回，或只回文件。
  - 从第n轮分叉：开新线程，可选新worktree。
- **单文件撤销**：用哈希校验，防止覆盖用户后来的修改（沿用旧版做法）。
- **快照范围**：大文件和.gitignore里的文件默认不进快照，可以配置。

## 5. 终端与预览

- **终端**：xterm.js+node-pty。每个线程都能开终端，和agent共享环境变量与cwd；agent跑的bash输出也能在终端面板里查看。
- **预览**：
  - 用electron的WebContentsView做内置浏览器，带devtools。
  - agent经cdp操作页面需要审批，并有源站白名单。
  - 截图可以直接放进对话。
  - 标注模式：在页面上圈选元素并写说明，作为下一轮的输入。
- **文件预览**：pdf、word、excel、ppt、图片、音视频只读预览，方便检查agent产出的文档和报表。

## 6. 通知与长任务

- **系统通知**：完成、待审批、失败时发出。
- **托盘常驻**：窗口关闭后任务继续，托盘菜单里显示运行中的线程。
- **防休眠**：有任务在运行时调用`powerSaveBlocker`。
- **goal模式**：设定目标、验收命令和预算，循环执行直到验收通过或预算用完。保留旧版的双状态验收。

## 7. 搜索、导出与分享

- **全局搜索**：搜线程标题和内容（sqlite fts5）。
- **导出**：markdown或json，可以选择脱敏。
- **在线分享**：1.0不做。

## 8. 外部ide

- 检测已安装的vs code、cursor、zed、jetbrains。
- 能从文件卡片、diff、终端链接直接跳到具体文件和行。
- **行内编辑**（M4）：在轻编辑器里选中代码、输入要求，生成diff后接受或拒绝。

## 子agent（2026-10-31实现）

- **工具**：xora engine的线程有一个host工具`agent`，参数是简短描述、完整任务、可选的已定义agent（`.xora/agents/`、`.claude/agents/`、数据目录的`agents/`），以及是否允许写文件。子线程、团队成员和工作流成员没有这个工具，不嵌套。
- **子线程**：每次调用开一个子线程，项目和目录同父线程，记下父线程和轮次。默认计划模式（只读）；允许写时沿用父线程的模式。模型优先用agent定义的模型或档位，否则用父线程的模型。
- **结果**：子agent最后一条消息交回父agent（最多2万字），允许写时附上改动的文件。父线程里显示子agent卡片：状态、花费，可以打开子线程。
- **限制**：每轮最多同时4个，多的排队；每个最长20分钟；停止父轮会停掉子线程。子线程的花费计入父线程。
- **@agent**：在composer里@一个已定义的agent，这一轮会附上指示，让线程的agent用`agent`工具交给它，结果回到本线程。

