# Xora Code 在线更新与版本服务设计

本文定义 Xora Code 桌面应用、Grok Build 组件、GitHub Release 镜像和
`xora-code.com` 版本站点的更新策略。目标是让更新检查与下载始终位于
IDE 启动、项目加载和 Agent 会话之外；任何网络、域名或服务端故障都不能
阻塞桌面窗口或改写当前安装。上游服务可能拒绝过旧的 CLI，组件更新必须能独立于桌面应用发布进行。

## Grok CLI 官方更新（已实现）

截至 2026-10-08，xAI 官方稳定指针与 npm `@xai-official/grok@latest` 均为
`1.0.46`。桌面包内的 `0.2.102` 仍作为可回退基线；首次联网使用时应在
“账户与模型设置 → 模型服务 → 运行时与更新”检查并安装最新 CLI。

`resources/update/config.json` 的 `source: "official-npm"` 启用官方分发路径：

- 只查询 HTTPS `registry.npmjs.org` 上 `@xai-official/grok` 的稳定标签及其
  精确版本平台依赖。固定官方包名、版本、操作系统、架构和下载地址，拒绝重定向。
- 校验元数据的 SHA-512 integrity，按大小上限流式解压 tar/gzip 与 Brotli。
  仅提取原生可执行文件及 notices，不执行 npm 安装脚本，不改系统 CLI 或共享 Grok 模型配置。
- 在独立临时 Grok Home 中检查精确 `--version` 与 ACP initialize，然后原子
  切换用户数据目录中的组件。保留内置基线与上一版本，启动时再次检查本地 SHA-256。
- 检查版本可以在 Agent 运行时进行。安装操作先下载和验证，成功后自动停止
  所有窗口的空闲 Agent（含取消尚在初始化的预热）；任何执行中任务、权限请求或命令查询均阻止激活。
  下载失败保留运行中的 Agent；切换完成后新连接使用新版本，不自动重发任务。
- 网络超时、完整性或 ACP 校验失败均可重试，失败不替换当前组件。持久化已见
  官方版本与 integrity，回滚后仍拒绝源端降级或同版本内容替换。
- Grok 1.x 的项目信任影响项目 Skills/MCP 发现。只在 Xora 已确认信任的
  当前项目根目录使用 `--trust` 启动和检查，认证临时目录及未信任目录不获得授权。
- 更新锁使用带独立 PID 标记的目录租约，并保留排他的 PID 文件锁兼容旧客户端；Windows 也不会通过目录替换覆盖旧锁。进程异常退出后的死锁可以重试回收，
  其他仍在运行的更新进程保持受保护。
- 首次更新复制内置回滚基线时，使用可写文件句柄刷盘以兼容 Windows；失败会清理本次临时副本，之后可以安全重试。

该路径信任 xAI 官方 npm 分发与 HTTPS 元数据，并验证对应 integrity，
不宣称 Xora Ed25519 签名或平台公证。`source: "xora-signed"` 保留独立的
Xora 签名清单策略；此策略仍必须配置可信公钥，不能退回未验签安装。
下文的签名清单、站点与自动安装规划用于 Xora 自建发布通道，桌面应用自动更新尚未启用。

## 1. 产品原则

1. **更新失败不损坏现有安装**：后台更新服务失败只写入本地脱敏日志，
   不阻塞窗口、项目、Agent Runtime、登录、MCP 或 Skills。手动更新明确显示
   可重试的失败原因；上游拒绝旧 CLI 时引导用户更新，不能承诺旧版永远可用。
2. **每个新版本只主动提醒一次**：自动检查发现 `0.2.4` 时最多展示一次。
   用户选择“暂不更新”后，不再为 `0.2.4` 主动提示；`0.2.5` 发布后可以
   再提示一次。用户仍可随时从“关于 / 检查更新”手动查看。
3. **不抢占正在进行的工作**：更新可以在后台下载，但不会自动关闭窗口、
   终止 Agent、取消终端或重放 Prompt。安装必须由用户确认，默认在退出后
   或下次启动时完成。
4. **两个独立更新域**：Xora 自建桌面应用和 Grok Build sidecar 继续使用独立的
   Ed25519 密钥、清单、序列号与回滚规则。更新桌面应用不会绕过 sidecar
   的兼容性门禁。
5. **Xora 自建通道只接受签名清单**：网页、GitHub Release 和镜像都只是分发面。
   客户端只接受由内嵌公钥验证通过、sequence 不倒退、版本和平台匹配的
   规范化 JSON 清单。

## 2. 域名与存储布局

建议将展示站和更新静态源分离：

```text
xora-code.com
├── /                         产品介绍
├── /download                 当前稳定版下载
├── /docs                     使用说明
└── /releases                 历史版本与变更说明

updates.xora-code.com
└── /v1
    ├── channels
    │   ├── stable.json       已签名桌面应用清单
    │   └── beta.json
    ├── sidecar
    │   └── stable.json       已签名 Grok Build 清单
    └── releases
        └── 0.2.4
            ├── darwin-arm64/...
            ├── darwin-x64/...
            ├── win32-x64/...
            ├── linux-x64/...
            ├── SHA256SUMS.txt
            └── release-notes.zh-CN.md
```

`updates.xora-code.com` 应只提供不可变静态文件。首选 Cloudflare R2 或其他
对象存储作为源站；现有新加坡服务器可以作为 Nginx 只读源站和同步节点，
但不应让客户端依赖动态数据库或单个 API 进程。Cloudflare 缓存清单时使用
较短 TTL，版本目录使用 `immutable` 长缓存。

发布流程同时上传 GitHub Release。域名源不可用时，客户端回退读取 GitHub
Release 中同名的已签名清单；两个来源的清单签名和 artifact hash 必须相同。
网页下载链接也可在主源不可用时回退到 GitHub。

## 3. 客户端检查状态机

```text
应用可交互
    │
    ├─ 延迟 10~30 秒并加入随机抖动
    │
    └─ 后台检查（4 秒连接 / 10 秒总超时）
          ├─ 主清单成功且签名有效 ── 比较版本
          ├─ 主清单不可达 ───────── GitHub 签名清单回退
          └─ 全部失败 ───────────── 静默结束并指数退避

发现新版本
    ├─ 已提醒/已跳过同一版本 ───── 不再主动提示
    └─ 第一次发现该版本 ───────── 显示一次轻量提醒
          ├─ 查看更新内容
          ├─ 后台下载
          └─ 暂不更新（仅跳过当前版本）
```

建议检查节奏：

- 首次检查：应用进入可交互状态后 10～30 秒，不进入启动关键路径。
- 后续检查：每 24 小时一次并加入随机抖动，避免所有客户端同时访问。
- 失败退避：1 小时、6 小时、24 小时；成功后恢复正常周期。
- 手动检查：无视本次会话退避，但仍受超时、签名和响应大小限制。
- 服务端返回 `429` 或 `Retry-After` 时遵守服务端间隔。

本地只持久化非敏感状态：

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "lastSuccessfulCheckAt": "2026-07-29T00:00:00.000Z",
  "lastPromptedVersion": "0.2.4",
  "skippedVersion": "0.2.4",
  "downloadedVersion": null,
  "minimumAcceptedSequence": 4
}
```

`lastPromptedVersion` 保证一次性提醒；版本号变化后自然允许再次提醒。自动
检查失败不得修改它，否则临时故障可能吞掉未来提醒。

## 4. 下载与安装

推荐使用 `electron-updater` 适配现有 electron-builder 产物，但在调用平台
安装器前增加 Xora 自己的签名清单门禁：

1. 验证 JCS + Ed25519 应用清单、sequence、channel、平台、架构和版本。
2. 后台下载到应用数据目录的 staging，不写入项目或 `~/.grok`。
3. 校验签名清单中的大小与 SHA-256，并让 electron-updater 继续校验
   electron-builder 的 SHA-512 元数据。
4. 校验平台签名：macOS Developer ID + notarization，Windows
   Authenticode；Linux 至少验证 Xora Ed25519 清单，deb 额外提供 GPG。
5. 下载成功只显示“重启后更新 / 稍后”，不自动退出当前应用。
6. 用户确认后先完成 Save All，等待或明确取消活跃 Agent/终端，再调用
   平台安装流程。绝不自动重放未完成的 Prompt。

平台边界：

| 平台 | 推荐自动更新产物 | 行为 |
| --- | --- | --- |
| macOS | DMG + ZIP | ZIP 供 updater 使用，DMG 供人工下载；必须 Developer ID 签名和公证 |
| Windows | NSIS | 后台下载，退出后由 NSIS 安装；必须 Authenticode 签名 |
| Linux AppImage | AppImage | 可原位更新并保留上一稳定文件 |
| Linux deb | deb | 默认提醒并下载，由包管理器确认安装，不静默提权 |

当前 `0.2.3` 稳定包和 `0.2.4` 预览包都没有正式平台商业签名，因此只能
作为手动下载版本，不能直接启用可信自动安装。应先配置 Apple、Windows、Linux GPG 与应用
Ed25519 发布密钥，再打开生产更新开关。

## 5. 发布、灰度与回退

- CI 在三种原生 runner 上构建，生成平台安装包、`latest*.yml`、SBOM、
  SHA-256 和两套独立签名清单。
- 发布必须先进入 staging，完成干净虚拟机安装/升级、签名、ACP initialize、
  登录保持、会话恢复和进程清理验证。
- 稳定清单使用单调 sequence；同一 sequence 不允许覆盖文件。
- 支持 `rolloutPercentage` 灰度发布。客户端以本地随机 ID 和版本 salt
  稳定分桶，不上传设备标识。
- 撤回坏版本时停止扩大灰度并发布更高版本号；不重写或删除已经签名的旧
  清单。保留当前稳定版和上一稳定版供人工回退。
- 数据迁移使用独立 `dataCompatEpoch`。迁移前备份，epoch 变化时禁止静默
  降级，必须由桌面应用明确提示。

## 6. 服务端故障与安全边界

- 客户端只访问无凭据 HTTPS URL，限制重定向仍为 HTTPS，并限制清单大小。
- 清单、说明站、GitHub、DNS 或新加坡服务器任意故障都不能改变当前应用
  状态；不得因更新失败重启 Electron 或 Grok sidecar。
- 已下载文件必须先验签再进入“可安装”状态；校验失败立即删除 staging，
  只在用户打开“更新详情”时显示原因。
- 更新日志不得记录授权头、Cookie、API Key、机器用户名、项目路径或
  `~/.grok` 内容。
- Cloudflare/WAF 只做缓存、限速和 DDoS 防护，不能替代客户端签名验证。

## 7. 分阶段实施

### 阶段 A：安全提醒

- 发布 `stable.json` 与历史版本页。
- 应用后台检查、一次性版本提醒、手动“检查更新”。
- 服务端或 GitHub 不可用时静默失败。

### 阶段 B：后台下载

- 接入 electron-updater。
- 增加进度、取消、断点续传、staging 与 hash 校验。
- 下载完成后由用户选择重启安装。

### 阶段 C：生产自动更新

- 配齐 Apple Developer ID + notarization、Windows Authenticode、
  Linux GPG、应用和 sidecar 两套 Ed25519 密钥。
- 完成灰度、回滚、健康标记和跨版本数据迁移测试后，才允许稳定通道默认
  开启在线安装。

## 8. 站点与服务器建议

新加坡服务器只需承担静态源站和同步任务：

- Nginx 只读托管 `/srv/xora-code/releases`，禁止目录写入 API。
- 发布用户使用独立 SSH key、最小目录权限和原子目录切换。
- CI 先上传到临时目录，核对 hash 与签名，再原子更新 channel 清单。
- Cloudflare 开启 Origin Certificate、强制 HTTPS、缓存不可变产物。
- 每小时从 GitHub Release 或发布存储做完整性巡检，发现差异只告警，
  不自动覆盖已签名清单。

产品介绍和使用说明可以独立部署到 `xora-code.com`，版本下载清单仍保持
纯静态与可镜像，使网页维护或服务端升级不会影响桌面应用更新检查。
