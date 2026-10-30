# 07｜模型接入（api与订阅）

## 1. 建模

- **连接**：由四样东西确定——厂商、通道、区域（国内或海外）、协议（openai chat、openai responses、anthropic messages）。
- **模型目录挂在连接下**：同一个模型在不同通道里id不同，比如kimi开放平台叫`kimi-k3.1-pro`，kimi code里叫`k3.1-pro`。
- **key不通用**：glm套餐key和标准key互不相认；kimi的key和站点绑定，混用会返回401。
- **通道有四种**：
  - **api**：按量付费。
  - **订阅key**：编程套餐发的key，在条款允许的范围内直连。
  - **官方agent**：订阅绑定在官方客户端上，经acp接入，xora不经手凭据。
  - **本地**：本机或局域网里的模型服务。
- **怪癖是数据**：每个模型都带能力和怪癖描述，运行时交给pi-ai的compat开关。pi没覆盖到的，用xora的请求改写钩子补。

## 2. 接入清单

| 类别 | 厂商或方式 | 协议 | 说明 |
|---|---|---|---|
| 国际api | openai、anthropic、google gemini、xai、openrouter、mistral | 各自原生协议 | pi-ai都已内置 |
| 国产api | deepseek、kimi（moonshot）、glm（智谱、z.ai）、qwen（阿里云百炼）、minimax、豆包（火山方舟）、硅基流动 | 以openai chat为主，anthropic备选 | 三家详情见第4节 |
| 编程订阅（key直连） | kimi code、minimax m plan、百炼coding plan、火山方舟coding plan；glm coding plan获准前只做引导 | 按官方推荐协议 | 接入前逐家核对条款 |
| 订阅（官方agent） | chatgpt（codex）、claude（claude code）、kimi会员（kimi code cli）、supergrok（grok build）、gemini（gemini cli）、copilot（copilot cli） | acp | 用户在agent里登录 |
| 本地 | ollama、lm studio、llama.cpp server、vllm | openai兼容 | 自动探测本机常用端口 |
| 自定义 | 任意openai或anthropic兼容端点，包括中转站 | 自选 | 可以配置怪癖开关 |

## 3. 订阅的两种接法

| | key直连 | 官方agent代管 |
|---|---|---|
| 适用 | 条款允许第三方工具使用的编程套餐 | 订阅只能在官方客户端里用（chatgpt、claude、grok等） |
| 方式 | 在xora里填套餐专用key和专用端点，xora engine直接请求 | 安装官方agent，在它自己的登录流程里登录；xora经acp驱动 |
| 优点 | 完全用xora的工具、审批、压缩、计量 | 合规；能用到官方模型的完整能力 |
| 限制 | 必须用xora真实的客户端标识；只做交互式使用 | 工具和压缩由对方决定；用量往往看不到 |

## 4. 国产三家要点（2026-10-29核对官方文档）

| | deepseek | kimi | glm |
|---|---|---|---|
| 按量端点 | `https://api.deepseek.com`（chat、responses），anthropic端点为`https://api.deepseek.com/anthropic`；国内外同一域名 | `https://api.moonshot.cn/v1`、`https://api.moonshot.ai/v1`；anthropic端点为`/anthropic` | `https://open.bigmodel.cn/api/paas/v4`、`https://api.z.ai/api/paas/v4`；responses为`/api/v1`；anthropic为`/api/anthropic` |
| 编程订阅 | 没有，只能按量付费 | kimi code：`https://api.kimi.com/coding/v1`（国内）、`https://api.kimi.ai/coding/v1`（海外），用独立key | coding plan：`https://open.bigmodel.cn/api/coding/paas/v4`（海外`https://api.z.ai/api/coding/paas/v4`），用专用key；端点填错会按量扣余额 |
| 主力模型 | `deepseek-flash`（v4.1 flash，1m上下文，最大输出384k，支持图片）、`deepseek-v4-pro` | `kimi-k3.1-pro`（1m，10-23上线）、`kimi-k3`；k2系列计划12月底下线 | `glm-5.3`（1m上下文，128k输出）、`glm-5.3-flash`（多模态）；都强制思考 |
| 思考参数 | `thinking.type`加`reasoning_effort`（none/low/high/max），默认开启，强度high | k3系列不传`thinking`，只用`reasoning_effort`（low/high/max，默认max） | `thinking:{type, clear_thinking}`加`reasoning_effort`（默认max） |
| 思考回传 | **带tools时，之后每次请求都要完整回传全部`reasoning_content`，否则报400** | 整条assistant消息原样回传，缺了报400 | 工具循环里要保留`reasoning_content`；保留式思考开着时，必须完整、按原顺序回传 |
| 采样参数 | 思考模式下temperature等参数不生效 | **k3锁定temperature=1.0、top_p=0.95，传别的值会被拒绝** | temperature取0～1 |
| tool_choice | 思考模式下传`required`或指定函数直接报400 | k2.x不支持`required` | 只支持`auto` |
| 缓存 | 全自动前缀缓存 | 自动前缀缓存，ttl默认5分钟，可选1小时（`prompt_cache_options`）；中途改effort会破坏缓存 | 隐式缓存，自动生效 |
| 价格（每百万token） | flash：高峰时命中0.04元、未命中2元、输出8元；空闲时段半价（高峰为工作日9–12点、14–18点） | k3：命中$0.30、未命中$3.00（官方缓存页）；k3.1-pro价格未核实 | 5.3：命中2元、输入8元、输出28元 |
| 订阅条款 | — | 允许第三方工具（官方名单末尾带"等"）；禁止伪装客户端标识、转售、反代共享、非交互自动化 | 只能在23个指定工具里用（含claude code、codex、opencode、pi coding agent、cline、cursor等），xora不在名单上，也没有公开的申请流程 |

另外：deepseek官方文档"接入agent工具"一栏里有自家的deepseek harness。经这些工具触发的服务端search/fetch，从2026-11-01起按每千次5元收费。

## 5. 引擎侧通用规则

1. assistant消息原样回传，包括`reasoning_content`、thinking块和signature，不剥离、不调换顺序。
2. 跨厂商切换模型时，先把历史压成摘要再开新上下文，避免回传格式不匹配导致400。
3. 采样参数走白名单：kimi k3和minimax不发temperature、top_p；deepseek在思考模式下也不必发。
4. `tool_choice`按厂商降级：glm只发`auto`；deepseek思考模式只发`auto`或`none`；kimi k2.x不发`required`。
5. 模型id在预设里写死，启动时请求`/models`核对。kimi code的模型id拼错不会报错，而是静默降级到非思考模型。
6. 会话内保持effort不变，否则kimi的缓存会失效。
7. sse解析要跳过keep-alive注释和空行（deepseek排队时会发）。
8. usage字段统一映射：deepseek是`prompt_cache_hit_tokens`和`prompt_cache_miss_tokens`，kimi是`cached_tokens`和`cache_write_tokens`，glm是`cached_tokens`。
9. 错误码统一归类为额度用尽、限速、过载、上下文超长、无权限，例如：
   - glm的业务码1261、1302、1305、1308/1310、1309、1311、1313
   - kimi code的403和429
   - deepseek的429（并发上限）

## 6. 协议选择

- 默认用openai chat completions：三家对它的怪癖文档最全，pi-ai也覆盖得最好。
- kimi code和glm coding按官方推荐的协议走。
- anthropic协议作备选。注意deepseek的anthropic端会忽略`cache_control`，模型名不是claude开头又不认识时会报400。
- 不依赖responses协议的服务端状态：deepseek和kimi是无状态的，glm是有状态的。

## 7. 模型角色、路由与回退

- **角色**：主模型、快速模型（标题、摘要、压缩、分类）、视觉模型、子agent默认模型；嵌入模型以后再加。
- **选择优先级**：线程设置 > 场景agent的偏好列表 > 全局默认。
- **回退链**：遇到429、过载、5xx时，按配置切到备用模型，优先同协议。跨厂商切换时先做摘要（规则2）。
- **成本护栏**：单轮和单线程都有预算，超出时暂停并询问（见11）。

## 8. 模型目录与预设

- **数据来源**：
  - 内置预设（人工核对）。
  - 可选导入models.dev（opencode使用的开源模型目录，许可未核实）。
  - 启动时请求厂商的`/models`接口核对。
- **在线更新**：预设是签名的数据包，热加载，可以回滚（见12）。
- **示例**（节选）：

```json
{
  "id": "deepseek", "channel": "api", "region": "global",
  "endpoints": {
    "openai_chat": "https://api.deepseek.com",
    "anthropic": "https://api.deepseek.com/anthropic"
  },
  "defaultWire": "openai_chat",
  "models": [
    { "id": "deepseek-flash", "context": 1048576, "maxOutput": 393216, "input": ["text", "image"],
      "reasoning": { "mode": "toggle", "default": true, "efforts": ["low", "high", "max"], "defaultEffort": "high" },
      "pricing": "deepseek-flash@2026-10" }
  ],
  "quirks": {
    "reasoningEcho": "required_if_tools",
    "toolChoiceWhenThinking": ["auto", "none"],
    "ignoredWhenThinking": ["temperature", "presence_penalty", "frequency_penalty"],
    "sseKeepAliveComments": true,
    "cache": "auto"
  },
  "compliance": { "subscription": false }
}
```

## 9. 设置流程

1. 选厂商，再选通道（api、订阅key、官方agent、本地）和区域。
2. 填key，存进系统钥匙串；官方agent则跳转到它的安装和登录。
3. 自动请求`/models`核对模型id。
4. "测试连接"发一次最小请求，验证思考回传和工具调用。
5. 显示价格、缓存规则和条款摘要。

## 10. 合规

- **glm coding plan**：条款只允许指定工具，xora不在名单上。默认不直连，界面引导用户改用标准api，或在名单内的工具里用套餐；同时向智谱申请加入名单。（xora最终没有嵌入pi，所以也不能借"pi coding agent"的名义。）
- **kimi code**：可以接，但必须用xora自己真实的客户端标识，不冒充kimi cli，不复用官方oauth，只做交互式使用。
- **官方订阅**（chatgpt、claude、grok等）：只走官方agent，xora不代为登录。anthropic的条款还规定，第三方产品未经批准不能提供claude.ai登录。
