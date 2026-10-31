# 05｜引擎层

## 1. 结论

- **默认引擎**：xora engine。它是一个独立的node子进程，对外说stdio acp。内核（wire层和agent循环）、acp服务端、工具、审批、子agent、压缩策略都是自研；内核选型的变化见第3节。
- **外部引擎**：任何acp agent都能接，包括codex-acp、claude-agent-acp、kimi code、opencode、qwen code、gemini cli、goose、grok build，以及deepseek harness的acp启动配置。

## 2. xora engine结构

```
packages/engine
├─ acp-server   会话new/load/resume/list/close、prompt、cancel、config options、权限请求、_xora/*扩展
├─ session      jsonl会话文件、恢复、换工作目录
├─ loop         agent循环：流式、并行只读工具、重试与回退、取消
├─ providers    packages/providers：两种wire加怪癖数据，见07
├─ tools        见04第3节
├─ permissions  规则匹配后向host发session/request_permission，最终裁决在host
├─ sandbox      shell工具经sandbox-runtime包装，见10
├─ context      压缩、裁剪、记忆注入，见08
├─ subagents    task工具、并发与预算，见06
├─ hooks        生命周期事件，见09
└─ metering     本地计量事件经_meta交给host，不外发
```

- **运行**：在应用里是bootstrap启动的electron utility process，用electron自带的node，不另带node，acp走MessagePort（见02第1节）；测试和不在electron里时用node启动，acp走stdio。
- **版本**：随应用包发布，可以热更新（见12）。
- **测试**：用test-kit里的mock模型服务做录制回放，按厂商建立怪癖回归集（见13）。

## 3. 内核选型

> 2026-10-30更新：实际实现没有用pi，改为自研wire层和agent循环，理由见16第1节（依赖体积、发版节奏、怪癖和回放要自己掌控）。下面保留当初选pi的分析，作为备选方案的依据。

### 3.1 当初为什么选pi

1. **国产模型怪癖可控**：
   - pi-ai内置deepseek、moonshotai（含cn）、kimi-coding、zai、zai-coding-cn、qwen-token-plan等provider。
   - 兼容开关有`thinkingFormat`（可选deepseek、zai、qwen等）、`requiresReasoningContentOnAssistantMessages`、`zaiToolStream`、`maxTokensField`、`cacheControlFormat`。
   - 不够用时可以`registerProvider`覆盖，或者把源码拉进来改。对比之下，opencode修deepseek问题的pr被机器人关了，codex只能等厂商修。
2. **纯js**：用electron自带的node就能跑，彻底去掉rust sidecar和三端源码编译。
3. **边界干净**：内核藏在自研的acp外壳后面。pi方向变了，可以只留pi-ai，或者换成ai sdk。

风险与对策：

- pi每周发版，1.2.0出过扩展接口的不兼容改动 → 锁版本，中间加一层适配。
- 子agent和计划模式按设计不内置，也没有审批和沙箱 → 这些本来就要自研。
- coding-agent包有安装统计开关（`PI_TELEMETRY`或设置项）→ 嵌入时显式关掉。`pi-telemetry`包本身不带上报器。

## 4. 外部引擎

- **引擎注册表**：记录启动命令、环境变量、来源（内置、acp注册表、用户自定义）、版本，以及`initialize`返回的能力。
- **引擎安装器**：从npm或官方发布渠道下载，校验integrity、版本和acp initialize三项后原子切换，保留上一版。这是旧版官方npm更新链的通用化。
- **订阅类agent**（codex、claude、kimi code cli、grok、gemini）：用户在agent自己的登录流程里登录，xora不经手凭据。
- **能力降级**：没有list/resume就不显示对应入口；没有`usage_update`时，用量显示"不可用"。
- **关闭免审批**：启动时传对应参数关掉（如grok的`_meta.yoloMode=false`）；关不掉的，在界面上标注"不经xora审批"。
- **grok build**：用官方预编译包`@xai-official/grok`（apache-2.0，六个平台），首次使用时下载。1.x支持`session/list`、`session/resume`、`session/close`和`session/set_config_option`（已核对上游源码）。
- **跨引擎委派**：xora engine的task工具可以把子任务交给外部acp agent，比如让codex实现、xora审查，结果以摘要返回。工作流里也可以给步骤指定外部引擎（见06）。
- **对外提供**：xora engine本身就是acp agent，以后可以直接给zed、jetbrains等客户端使用。

## 5. 候选对比（2026-10-29核对）

| 方案 | 许可 | 语言与分发 | 嵌入方式 | 国产模型 | 结论 |
|---|---|---|---|---|---|
| pi（`earendil-works/pi`，1.4.0） | mit | ts，纯js | 进程内sdk，或jsonl rpc | 内置三家及编程套餐，有兼容开关 | **做内核** |
| opencode（`anomalyco/opencode`，1.19.5） | mit | ts/bun，单文件二进制 | `opencode serve`（http+sse），`opencode acp` | 内置；deepseek思考模式多轮工具调用报400（#24122）未修复 | 外部引擎；投入不足时的备选核心 |
| codex app-server（0.165.0） | apache-2.0 | rust，npm六平台预编译 | json-rpc，官方标注实验性 | `wire_api`只剩`responses`；三家的responses端点兼容不完整 | 外部引擎；沙箱实现可参考 |
| claude agent sdk | 专有，受商业条款约束 | ts/py，带闭源二进制 | sdk；acp走claude-agent-acp | 能指向anthropic兼容端点，但修不了协议怪癖 | 只作外部引擎 |
| goose（`aaif-goose/goose`） | apache-2.0 | rust | acp server | 处理怪癖要写rust | 外部引擎 |
| kimi code cli（`MoonshotAI/kimi-code`） | mit | ts | acp | kimi原生 | kimi会员通道 |
| qwen code、gemini cli | apache-2.0 | ts | acp | 多provider或只接gemini | 外部引擎 |
| cline sdk（0.2.0） | apache-2.0 | ts | 进程内sdk | 多厂商 | 备选内核，还在0.x |
| crush | fsl-1.1-mit | go | http+sse | — | 许可证禁止"competing use"，排除 |
| 纯自研 | — | ts | — | 完全可控 | 工作量多出约一倍 |

## 6. 工作量

按一名资深开发者加ai辅助估算，不含界面。这是调研阶段的估计，要以实际开发校准。

| 模块 | 要点 | 人周 |
|---|---|---|
| provider适配 | 国产怪癖、编程端点、模型目录、缓存与用量 | 2～3 |
| agent循环 | 流式、并行工具、插话与中断、重试 | 0.5 |
| 工具集 | 读写、编辑（兼容`apply_patch`）、grep/glob、bash、web、待办 | 1～2 |
| 权限与沙箱 | 规则引擎、审批桥接、mac seatbelt、linux bwrap | 3～5 |
| 上下文压缩 | 分级压缩、预压缩 | 1～2 |
| 子agent | task工具、隔离上下文、并发与预算 | 1～2 |
| mcp客户端 | stdio、http、oauth | 0.5～1 |
| 会话与检查点 | jsonl会话树、fork、影子git | 2～3 |
| hooks、skills、agents.md | 沿用claude/codex的约定 | 2～3 |
| acp服务端 | 会话全套、权限、config options、`_xora/*` | 2～3 |
| 回归与打包 | 怪癖回归集、录制回放 | 2～3 |
| 合计 | | 约17～29人周；最小可用版6～8人周 |
