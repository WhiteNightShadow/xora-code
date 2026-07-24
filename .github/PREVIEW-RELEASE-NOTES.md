# Xora Code {{VERSION}} Preview

> ⚠️ **这是供测试与验收使用的未签名预览版，不是正式稳定版。** 请仅从本仓库的 GitHub Release 下载，并在安装前核对随附的 SHA-256。

Xora Code 是一款由社区独立维护的开源 Grok 桌面应用，基于 Grok Build、Eclipse Theia、Electron 与 ACP，为 macOS、Windows 和 Linux 提供可视化的编程 Agent 工作流。本项目不是 xAI 官方客户端，与 xAI 无隶属、赞助或背书关系。

- 源码提交：`{{FULL_SHA}}`
- Preview 标识：`{{TAG}}`
- 构建记录：{{RUN_URL}}
- 内嵌运行时：固定版本 Grok Build `0.2.102`

## 本次预览重点

- **Grok 桌面 Agent 工作台**：将项目树、Monaco 编辑器、搜索、Diff、终端与固定的 Xora Code Agent 面板放在同一界面。
- **Grok Build + ACP**：支持认证、新建/恢复会话、流式回复、Plan、工具活动、权限请求、取消和崩溃处理。
- **订阅与自定义模型**：支持 Grok 订阅，以及可配置 Base URL、API Key、模型 ID 和上下文窗口的 OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages 兼容服务。
- **全局模型一致性**：在设置中切换订阅或自定义 Provider 后，Agent 选择器、新会话、历史会话与其他项目统一采用当前配置。
- **更快的首次交互**：项目打开后预热 Runtime，发送时立即显示本地状态，后台完成会话建立和 Save All，降低首轮无反馈等待。
- **可审查变更**：文件、搜索、终端、网络、Skill、MCP 和 Plugin 活动分类呈现，支持原生 Diff 与哈希保护的安全撤销。
- **会话、图片与上下文**：本地保存脱敏会话历史，支持能力受控的 PNG/JPEG/WebP 输入，并展示 Grok Build 提供的 Token 和原生压缩状态。
- **安全边界**：密钥由 Electron `safeStorage` 保存，进程、网络和最终权限裁决留在主进程；日志、会话和活动事件在持久化前脱敏。

## 平台产物

- macOS arm64 / x64：DMG + ZIP；应用仅使用 ad-hoc 签名，**没有 Developer ID，也没有 notarize**。
- Windows x64：NSIS 安装包；**没有 Authenticode 产品签名**，Windows 可能显示 SmartScreen 警告。
- Linux x64：AppImage + deb；仅提供 SHA-256 校验和，**没有 GPG detached signature**。

每个平台同时提供独立的 CycloneDX JSON SBOM、构建来源信息与覆盖安装包及 SBOM 的 `SHA256SUMS-<target>.txt`。SBOM 由仓库锁定并校验官方资产 SHA-256 的 Anchore Syft `1.48.0` 生成：它扫描实际打包 payload，并合并该源码提交的锁定依赖树作为保守清单，以覆盖 ASAR 和 stripped Rust 二进制中无法直接识别的依赖。

## 构建门禁

每个平台都在对应的原生环境（GitHub Actions Runner 或专用原生构建机）重新构建固定 Grok 源码，并执行 ACP 初始化、认证、进程清理 smoke test、工作区测试和安装包构建。两条构建路径使用相同的 target verifier 校验精确产物集合、来源信息、组合 SBOM 和 SHA-256；Windows 的 Grok/ACP/认证/进程清理测试失败会直接阻断发布。

本 Preview 不生成应用或 sidecar 的 Ed25519 更新清单，不生成 GPG `.asc`，不会替代 Latest，也不会绕过正式 Release 的签名与信任锚门禁。

## 已知限制

- 当前仍是 Alpha，未经平台商业签名和 macOS 公证，安装时可能触发 Gatekeeper 或 SmartScreen 警告。
- Skills、MCP 和 Plugins 的管理界面已可体验，兼容来源汇总与运行期无中断刷新仍在完善。
- 正式组件更新与稳定 Release 会继续保持关闭，直到 Apple、Windows、Linux GPG 与独立 Ed25519 信任锚全部完成配置并通过验收。
