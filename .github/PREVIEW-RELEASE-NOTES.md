# Xora Code {{VERSION}} Preview

> ⚠️ **这是供测试与验收使用的未签名预览版，不是正式稳定版。** 请仅从本仓库的 GitHub Release 下载，并在安装前核对随附的 SHA-256。

- 源码提交：`{{FULL_SHA}}`
- Preview 标识：`{{TAG}}`
- 构建记录：{{RUN_URL}}
- 内嵌运行时：固定版本 Grok Build `0.2.102`

## 平台产物

- macOS arm64 / x64：DMG + ZIP；应用仅使用 ad-hoc 签名，**没有 Developer ID，也没有 notarize**。
- Windows x64：NSIS 安装包；**没有 Authenticode 产品签名**，Windows 可能显示 SmartScreen 警告。
- Linux x64：AppImage + deb；仅提供 SHA-256 校验和，**没有 GPG detached signature**。

## 构建门禁

每个平台都在对应的原生 GitHub runner 上重新构建固定 Grok 源码，并执行 ACP 初始化、认证、进程清理 smoke test、工作区测试和安装包构建。Windows 的 Grok/ACP/认证/进程清理测试失败会直接阻断发布。

本 Preview 不生成应用或 sidecar 的 Ed25519 更新清单，不生成 GPG `.asc`，不会替代 Latest，也不会绕过正式 Release 的签名与信任锚门禁。
