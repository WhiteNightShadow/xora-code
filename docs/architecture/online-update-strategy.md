# Xora Code 在线更新与版本服务设计

本文定义 Xora Code 桌面应用、Grok Build 组件、GitHub Release 镜像和
`xora-code.com` 版本站点的更新策略。目标是让更新检查与下载始终位于
IDE 启动、项目加载和 Agent 会话之外；任何网络、域名或服务端故障都不能
影响用户继续使用当前已安装版本。

## 1. 产品原则

1. **当前版本永远可用**：更新服务失败只写入本地脱敏日志，不弹错误框，
   不阻塞窗口、项目、Agent Runtime、登录、MCP 或 Skills。
2. **每个新版本只主动提醒一次**：自动检查发现 `0.2.4` 时最多展示一次。
   用户选择“暂不更新”后，不再为 `0.2.4` 主动提示；`0.2.5` 发布后可以
   再提示一次。用户仍可随时从“关于 / 检查更新”手动查看。
3. **不抢占正在进行的工作**：更新可以在后台下载，但不会自动关闭窗口、
   终止 Agent、取消终端或重放 Prompt。安装必须由用户确认，默认在退出后
   或下次启动时完成。
4. **两个独立更新域**：桌面应用和 Grok Build sidecar 继续使用独立的
   Ed25519 密钥、清单、序列号与回滚规则。更新桌面应用不会绕过 sidecar
   的兼容性门禁。
5. **签名清单是唯一发布事实**：网页、GitHub Release 和镜像都只是分发面。
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
