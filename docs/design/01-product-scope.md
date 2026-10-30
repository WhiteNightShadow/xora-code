# 01｜产品定位与范围

## 1. 定位

- 一款三平台（macos、windows、linux）的agent优先编程桌面。用户按"项目→线程"组织任务，agent在本地或独立worktree里改代码，人负责审批和审阅。
- 模型中立：既能用自己的api key（国际、国产、本地、中转站），也能通过官方agent用已有的订阅。
- 面向场景：除了通用编码，还内置代码审查、修bug、写测试、文档、接口分析与爬虫、逆向分析、运维排障等场景模板，并可以通过市场扩展。
- 面向长期任务：可以创建常驻的agent团队，下发任务、编排工作流（见06）。

## 2. 目标用户

| 用户 | 关心什么 |
|---|---|
| 个人开发者 | 多模型、控成本、国产模型好用、本地优先 |
| 小团队 | 共享场景agent、skills、mcp配置和提示词（入库的`AGENTS.md`和`.xora/`） |
| 要长期跑任务的用户 | 常驻agent团队、任务下发、工作流、定时任务 |

## 3. 1.0范围

**做：**

- agent优先主界面、线程与worktree、审阅与检查点、终端、浏览器预览
- xora engine，以及外部acp agent
- 国际、国产、本地、自定义模型，api和订阅都支持
- 提示词分层、上下文压缩、记忆
- skills、mcp、插件、hooks
- agent团队、任务下发、工作流、子agent、定时任务
- 用量计量与成本、订阅额度、预算
- 热更新、自动回滚、修复模式
- 三端安装包

**1.0之后：**

- 完整ide能力（调试器、vs code插件），1.0先用"在外部ide打开"代替
- 云端执行、ssh远程主机、手机遥控
- 团队协作与账户同步
- 可视化工作流编辑器，以及外部渠道（飞书、钉钉、企业微信、slack、github）下发任务

## 4. 业界对标（2026-10）

2026年的主线是把agent管理台从ide里拆出来，ide降为"需要时再打开"的第二形态。各家进程架构基本一致：无状态的ui、常驻的host、引擎子进程（json-rpc over stdio），再到模型。

| 产品 | 形态 | 借鉴 |
|---|---|---|
| codex app（2月mac，3月win，8月linux预览） | electron外壳；桌面、vs code扩展、tui、web都连同一个codex app-server（thread/turn/item） | 线程可选local、worktree、cloud，之间能迁移；审阅按unstaged、staged、上一轮、分支查看，hunk级暂存还原，行评论直接交给agent；worktree默认保留15个，删除前快照 |
| cursor 3 agents window（4月） | vs code分叉里重写的agent窗口，和ide并存 | 本地、worktree、云端、ssh都在一个侧栏；`/best-of-n`让多个模型各占一个worktree |
| claude桌面code标签 | 会话侧栏加可拖拽面板 | 五档权限模式；显示pr的ci状态并自动修复；系统通知 |
| antigravity 2.0（5月） | 独立的指挥中心，没有编辑器 | 桌面、cli、sdk共用同一个harness |
| qoder 1.0（5月） | 独立桌面端，10-16下线ide里的quest窗口 | 任务分运行中、等待确认、已完成三态，结束时给交付清单；下线旧形态时提供一键导入 |
| zed（4月parallel agents） | rust原生编辑器，acp的发起方 | 线程按项目归组，每个线程可选不同的acp agent |
| kiro crew（8月开源） | 常驻gateway加多种客户端 | 每个会话经acp挂不同后端 |
| deepseek harness（8-13发布，mit） | electron外壳以node模式拉起本地host，host跑完整web app，"一切皆插件"（cordis） | 启动配置分web、headless、sdk、acp；会话是只追加的事件日志，已提交的版本文件永不改写；有轨迹视图、定时任务、插件管理 |

三平台一致可以成为差异点：据调研，codex的linux版8月才出预览，claude桌面的linux支持还是beta，conductor只有mac版。

要保留的核心能力和交互逐项列在[15](15-parity-advantages.md)；能力差距落在03～12；调研来源见[附录](appendix-sources.md)。

## 5. 旧版经验

### 5.1 要保留的做法

- 不可变快照加哈希校验的撤销
- goal的双状态验收
- mcp三态诊断和热更新
- 官方npm更新链：integrity校验、独立目录里先验证、原子切换、保留回滚基线
- 发布安全门：源码归档哈希、路径与秘密扫描、sbom
- 引擎中立的事件模型（文本、思考、计划、工具调用、权限、diff、goal）

### 5.2 旧问题转成新版约束

| 旧版问题 | 新版约束 | 落在哪 |
|---|---|---|
| api会话写死`always-approve`，审批、路径边界、规则全部失效（P0） | 审批由host裁决；外部agent启动时关闭免审批；契约测试断言会收到权限请求 | 05、10 |
| 历史脱敏误伤，而且在写盘前执行，不可逆 | 本地存原文（可选加密），只在导出、分享、上报时脱敏 | 02、10 |
| 取消在agent确认之前就生效 | turn状态机，以`stopReason`为准 | 02 |
| 历史按内容指纹去重，丢失相同的流式分片 | 事件带单调`seq`，按`seq`合并 | 02 |
| renderer能调用host任意方法 | 协议白名单加schema校验 | 02 |
| 一行坏json断开全部会话；stdin没有error监听 | 单行容错、按会话隔离、监听流错误 | 05 |
| 热路径同步io；每次启动对108mb二进制算哈希 | host全异步；校验结果缓存 | 02、12 |
| 路径先词法normalize再realpath | 先realpath再判断 | 10 |
| 窗口重载丢草稿、停运行时 | ui无状态，草稿和队列放在host | 02 |
| 时间线没有虚拟列表 | 虚拟列表、稳定key | 03 |
| diff是"整文件删+整文件加" | 真diff和hunk操作 | 04 |
| 一个索引坏了，全部历史不可用 | 每线程独立日志，sqlite能从日志重建 | 02 |
| 内置108mb rust sidecar，三端都要源码编译 | 纯js引擎，外部agent按需下载 | 05、13 |
| 测试是对源码做正则匹配 | 行为测试（vitest、testing-library、playwright） | 13 |
| 停止维护的electron还在用 | 跟随electron最新稳定版的前一版，每季度升级 | 13 |

### 5.3 grok build作为底层的教训

- 采样层没有extra_body，发不了glm、deepseek的`thinking`参数；messages后端会固定发claude专用的思考参数。国产模型的怪癖只能等上游修。
- 遥测和轨迹上传由xai远端开关控制。2026-07还发生过整仓库上传的隐私事件（[the register](https://www.theregister.com/a/5271123)）。
- 迭代极快：内置的0.2.102（2026-07-16）到10月底已落后官方1.0.70约90个版本，开源镜像还比npm滞后约一个月。
- 结论：外部引擎不能当内核用，只能作为可选的acp agent接入。
