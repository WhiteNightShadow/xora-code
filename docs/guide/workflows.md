# 工作流

工作流把一件常做的事固定成几个步骤：谁做、按什么顺序、怎么验收、哪里要你确认。写好后可以手动运行，也可以按定时、文件变化、git提交或webhook自动运行。

## 放在哪

| 位置 | 用途 |
|---|---|
| 项目的`.xora/workflows/<name>.yaml` | 跟着仓库走，项目受信任后才能运行，只有这里的工作流能自动运行 |
| 数据目录的`workflows/<name>.yaml` | 你自己的，任何项目都能手动运行 |

数据目录：mac是`~/Library/Application Support/xora-code`，windows是`%APPDATA%\xora-code`，linux是`~/.config/xora-code`。

在侧栏项目名右边点“工作流”图标，能看到这个项目可用的全部工作流。文件有问题时会列出每个问题的位置，修好之前不能运行。

也可以让agent帮你写：在做成过这件事的线程里，点右上角菜单的“沉淀为工作流”。它会新开一个线程，参照原来的记录起草文件，写入前会弹出审批卡片让你看内容。

## 一个例子

```yaml
name: bugfix
title: 修缺陷
inputs:
  issue: { description: 问题描述或链接 }
budget: { perRun: 20 }
steps:
  - id: reproduce
    agent: debugger
    task: "复现：{{inputs.issue}}，写一个现在会失败的测试"
    outputs: [testFile]
    verify: { command: "pnpm test -- {{steps.reproduce.outputs.testFile}}", expect: fail }
  - id: fix
    type: supervise
    needs: [reproduce]
    goal: "修好问题，让{{steps.reproduce.outputs.testFile}}通过，且不破坏其他测试"
    verify: { command: "pnpm test" }
  - id: review
    agent: reviewer
    needs: [fix]
    task: 审查fix这一步的全部改动
  - id: approve
    needs: [review]
    gate: human
    message: 确认后提交
  - id: commit
    needs: [approve]
    run: "git commit -am 'fix: {{inputs.issue}}'"
```

## 字段

| 字段 | 说明 |
|---|---|
| `name` | 小写字母、数字和`-`，和文件名一致 |
| `title`、`description` | 列表里显示 |
| `inputs` | 运行时要填的值，`type`可以是`string`、`number`、`boolean`；有`default`的可以不填 |
| `budget` | `perRun`是每次运行的上限，单位是设置里的显示币种；不写就用组织的默认预算 |
| `autonomy` | 手动运行时的自主级别，默认用组织的 |
| `concurrency` | 最多同时跑几个步骤，默认3 |
| `steps` | 步骤，见下 |
| `trigger` | 自动运行的条件，见“自动运行” |

## 步骤

每个步骤都有`id`，可以写`title`、`needs`（等哪些步骤完成）和`if`（条件）。类型按写了哪个字段来认：

| 类型 | 怎么写 | 做什么 |
|---|---|---|
| agent | `agent`和`task` | 组织里的一个agent在自己的线程里做这件事，用`step_result`工具交回总结和`outputs` |
| 主管编排 | `type: supervise`和`goal` | 交给团队：主管拆任务、派工、验收，完成后这一步才算完成 |
| 人工关卡 | `gate: human` | 停下来等你确认；拒绝就结束这次运行 |
| 命令 | `run` | 在项目目录里运行一条命令 |
| 子工作流 | `workflow`和`inputs` | 运行另一个工作流，最多嵌套3层 |

- agent可以用组织里的任何一个：`scout`侦察、`coder`编码、`tester`测试、`debugger`修bug、`reviewer`审查、`writer`文档、`planner`规划。`tier`可以指定档位（`flagship`、`standard`、`economy`、`fast`）。
- `verify`是验收命令：`expect: pass`（默认）要求退出码为0，`expect: fail`要求失败，适合“先写一个会失败的测试”。
- `onFailure`是失败后怎么办，按顺序试：`retries`次带着失败原因重做（默认1次），`escalate`升一档再做（默认开），`agent`换一个agent做，最后按`finally`：`abort`结束运行（默认）、`skip`跳过这一步、`ask`问你。

## 顺序、条件和引用

- 一个步骤在`needs`里的步骤都成功后开始；互不依赖的步骤同时运行。并行的步骤共用项目目录，会改同一批文件的步骤要用`needs`排先后。
- 依赖的步骤没有成功（失败或被跳过），这一步会被跳过。想在失败时做点别的，用`if`：`if: "steps.check.outcome == 'failed'"`。
- `if`可以写一个引用（有值、不是`false`或`0`就成立），前面加`!`取反，或者用`==`、`!=`和带引号的文本、数字、`true`、`false`比较。
- 可以引用的值：

| 写法 | 值 |
|---|---|
| `{{inputs.<名字>}}` | 输入 |
| `{{steps.<id>.outputs.<名字>}}` | 步骤交回的输出（要先在`outputs`里声明） |
| `{{steps.<id>.summary}}` | 步骤的总结 |
| `{{steps.<id>.outcome}}` | 步骤的结果：`succeeded`、`failed`、`skipped`等 |
| `{{trigger.files}}` | 文件触发时变化的文件 |
| `{{trigger.branch}}`、`{{trigger.commit}}` | git触发时的分支和提交 |
| `{{trigger.payload}}` | webhook的请求体 |
| `{{run.id}}`、`{{run.reason}}` | 运行id和启动原因 |

- 一个步骤只能引用它等过的步骤（写在`needs`里，或者间接依赖的）；验收命令还可以用这一步自己的输出。
- 代入`verify`和`run`的命令时，每个值都会按shell的规则加上引号，输入和agent交回的内容不会变成命令的一部分。

## 运行

- 在工作流列表里点“运行”，填好输入、预算，再点“开始运行”。勾上“等到空闲时段再运行”时，会按用到的模型的峰谷时段排队，空闲时段价格更低（比如deepseek工作日9–12点、14–18点以外半价）。
- 运行视图里能看到每一步的状态、交回的输出、花费，以及在等你处理的关卡和命令。agent步骤里的工具调用（写文件、运行命令）在它自己的线程里审批，步骤上会标“等你审批”，点“打开线程”去处理。
- 花费到预算就暂停，正在进行的agent轮次也会停下；追加预算后继续，没做完的步骤在原来的线程里接着做。
- 应用重启时没结束的运行会暂停，点“继续”从没做完的步骤接着做，做完的步骤不会重做。

## 自动运行

```yaml
trigger:
  schedule: "0 2 * * *"        # 每天2点；也可以写成列表
  timezone: Asia/Shanghai      # 缺省用系统时区
  missed: skip                 # 应用没开时错过的定时：skip不补，once在下次启动时补一次
  files: { paths: ["src/**"], ignore: ["**/*.snap"], debounceSeconds: 10 }
  git: { on: [commit, branch], branches: [main] }
  webhook: true
  offPeakOnly: true            # 等空闲时段再开始
```

- **要你逐个启用**：在工作流列表里打开“自动运行”。启用时会记下文件的内容，文件改了（拉了新代码、自己改了）就自动停用，确认内容后重新启用。这样一个仓库不能靠提交一个文件就在你的电脑上定时跑东西。
- **只在应用运行时生效**：启用了自动运行（或者有运行没结束）时，关窗口不会退出，应用留在托盘里继续工作；从菜单退出应用后就不再触发，错过的定时按`missed`处理。
- **定时**：五段cron（分、时、日、月、周），支持`*`、列表、范围、步长、月份和星期的英文缩写，以及`@hourly`、`@daily`、`@weekly`、`@monthly`、`@yearly`。夏令时跳过的钟点顺延执行，重复的钟点只执行一次。
- **文件变化**：`paths`和`ignore`用glob写，相对于项目根目录；`.git`和`node_modules`里的变化不算。变化停下`debounceSeconds`秒后触发一次。工作流自己改的文件不会再触发它。
- **git**：每30秒看一次各分支的最新提交，`branches`为空表示所有分支，可以写glob。
- **webhook**：启用后在列表里点“查看webhook地址”，用`POST`请求这个地址，带上请求头`Authorization: Bearer <token>`。只监听本机（127.0.0.1），同一个工作流5秒内只触发一次，请求体最多64kb。
- **限制**：自动运行没人盯着，所以不用订阅额度（api、本地模型和自定义端点都可以），必须有预算，agent不能是完全放行模式，用到的模型都要能计价。条件不满足时这次运行记为失败、写明原因，并停用自动运行；改好后重新启用。上一次运行还没结束时，新的触发会跳过。
- 自动运行里需要确认的命令和关卡照样会等你处理。想无人值守跑完，就给这些命令在权限设置里加允许规则，不要放关卡。
