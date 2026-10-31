# 10｜权限与安全

## 1. 原则

- 判定一律在host做。引擎只负责发起请求，ui只负责展示和回传用户的选择。
- 每个审批请求带一次性id和过期时间，回传必须对得上。
- 默认安全：新项目默认"询问"模式，不受信仓库默认禁用hooks和mcp（见09）。
- agent级隔离：每个常驻agent有独立的权限档、工作目录、可用凭据和预算（见06）。一个agent出问题，不会波及其他agent的权限。

## 2. 权限模式

| 模式 | 读 | 工作区内写 | 命令 | 网络 |
|---|---|---|---|---|
| 询问（默认） | 放行 | 询问 | 询问 | 按规则 |
| 自动编辑 | 放行 | 放行 | 只读命令白名单放行，其余询问 | 按规则 |
| 计划 | 放行 | 拒绝 | 只放行只读命令 | 按规则 |
| 全权 | 放行 | 放行 | 放行，但仍在沙箱和路径边界内 | 按规则 |

- 模式可以随时降级，包括任务运行中；升级到全权需要二次确认。
- 场景agent可以设默认模式，比如运维排障场景禁用全权。

## 3. 规则

- 规则分allow、ask、deny三种，按"工具+参数"匹配：命令前缀、路径glob、域名、mcp工具名。deny优先。
- 来源分全局、项目、会话三级，界面上标出每条规则来自哪里，可以一键删除。
- 外部agent能关掉自身"免审批"开关的，启动时一律关掉（如grok的`yoloMode=false`）；关不掉的，界面上明确标注"该agent不经xora审批"。
- 契约测试：用fake acp agent覆盖每种模式，断言该询问的都会收到权限请求。

## 4. 路径策略

- 先realpath再判断。不存在的新文件，就逐级解析它的父目录。
- 允许的根目录：工作区根、worktree根、用户批准的附加目录。
- 拒绝`..`越界和符号链接越界。
- 敏感文件默认询问：`.env*`、`~/.ssh`、密钥和证书文件、钥匙串导出文件。

## 5. os沙箱

适用于xora engine的shell工具和hooks命令；外部agent的进程能包装的也包装。

- **macos**：`sandbox-exec`（seatbelt profile）。工作区可写，其余只读，网络按策略开关。claude code、codex和grok的新版本都用这个思路。
- **linux**：bubblewrap，可选seccomp。系统里没有bwrap时，降级为只做路径策略，并在界面上提示。
- **windows**：先不做系统级沙箱，只做路径和命令策略。sandbox-runtime在windows上还是alpha，以后再评估受限令牌或appcontainer。
- 实现基于`@anthropic-ai/sandbox-runtime`（apache-2.0），在xora里封装一层，方便以后替换。

## 6. 凭据

- api key和oauth令牌存系统钥匙串：主进程用electron的`safeStorage`加密后落盘，只有主进程能解密。macos上的钥匙串项叫“xora-code Safe Storage”，和旧版0.2.x的“Xora Code Safe Storage”分开，升级时不弹授权框。
- key经环境变量或初始化消息交给引擎进程。shell工具派生子进程前，会剔除`*_API_KEY`、`*_TOKEN`等变量，agent执行的命令看不到这些key。
- 订阅key单独标注用途，只给对应的编程端点用。
- 日志、事件、诊断包里一律不出现密钥。
- **安装包的electron fuses**（打包时写进electron二进制，配置在`apps/desktop/electron-builder.yml`）：
  - 关掉：`RunAsNode`（`ELECTRON_RUN_AS_NODE=1`不再生效。开着时谁都能把这个二进制当node用，还能开调试器，调试参数那根fuse管不到这种模式）；主进程的`--inspect`等调试参数和SIGUSR1（不让别的进程挂上调试器、借主进程调`safeStorage`解密）；`NODE_OPTIONS`和`NODE_EXTRA_CA_CERTS`；`file://`页面的额外权限（修复模式页面因此改走`xora://safe-mode/`）。
  - 打开：cookie加密；app.asar完整性校验（mac、windows）；只从app.asar加载代码。
  - 关`RunAsNode`的前提是xora engine不再用`ELECTRON_RUN_AS_NODE=1`启动，改成utility process（见02第1节）。bootstrap只启动它正在用的、已验签应用包里的文件（`engine/index.cjs`），不接受包外的路径；引擎的环境变量里去掉`ELECTRON_RUN_AS_NODE`，host启动时也把它从自己的环境里删掉，外部agent、agent执行的命令和终端都继承不到。
  - `RunAsNode`关掉后，`child_process.fork`会直接报错（electron 44.10.0已核对），要起node进程只能用utility process。已知影响：windows上node-pty关闭终端时要fork一个脚本查询控制台里的进程，这一步会失败（host日志里记一条未处理的rejection），终端照常关闭，只是少了逐个结束其中子进程这一步；待windows实机核对。
  - 关掉`NODE_OPTIONS`后，`NODE_EXTRA_CA_CERTS`也不再生效。host和引擎启动时把系统证书库里受信任的证书加进来，企业代理的根证书装进系统证书库就能用。
  - mac上不签名的包，翻转fuses后要重新做ad-hoc签名（`resetAdHocDarwinSignature`），否则apple silicon拒绝启动。

## 7. 隐私

- **本地优先**：默认不上传任何数据。
- **遥测和崩溃上报**：默认关闭，由用户开启，并说明会上传什么。崩溃转储先存在本地，用户确认后才上传。
- **外部agent**：xora给外部agent设置隐私相关的环境变量，比如grok sidecar默认带`GROK_TELEMETRY_ENABLED=0`。
- **本地数据**：
  - 线程日志存原文，可以选择加密，密钥放在系统钥匙串里。
  - 导出、分享、上报时再脱敏。
  - 脱敏只匹配已知的密钥形态，加边界和熵阈值（旧版教训见01）。
- **网络**：xora engine可以配置出网白名单，默认只放行模型端点和用户允许的域名。

## 8. 安全测试

- 权限契约测试（第3节）。
- 路径越界用例：符号链接、`..`、大小写不敏感的文件系统、windows盘符和unc路径。
- 恶意仓库用例：在不受信仓库里放hooks、mcp配置、skills脚本，验证默认不执行。
- 依赖审计：ci里跑依赖漏洞扫描，并生成sbom。
