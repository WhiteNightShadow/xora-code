# 13｜构建、测试与发布

## 1. 本地开发

- `pnpm install`、`pnpm dev`：M0是先构建再启动，热重载放到M1。
- 工具链用node 24 lts和pnpm 12（`corepack enable pnpm`）；运行时用electron自带的node。
- pnpm 12只给`pnpm-workspace.yaml`里`allowBuilds`列出的包运行安装脚本，目前只放行esbuild。electron 44改成第一次用到时才下载二进制，不需要安装脚本。
- 包之间的依赖规则以后由ci检查（见02）。

## 2. 三端出包

- **原生模块**：
  - 只剩node-pty，它自带darwin、linux、win32的x64和arm64预编译。
  - sqlite优先用node内置的`node:sqlite`，不行再用better-sqlite3（有预编译）。
- **出包**：在mac上一次出六个目标：`electron-builder --mac --win --linux --x64 --arm64`。pabox已经在本机这样交叉打过windows安装包。
- **冒烟**：
  - **mac**：本机安装运行。
  - **linux x64**：lima虚拟机里的amd64容器（rosetta），在xvfb下跑playwright冒烟。
  - **windows**：qemu里的win11 arm64测试机（ssh `127.0.0.1:2222`）。arm64包可以原生跑；x64包靠prism转译，只算功能验证，x64实机验收另找机器。
- **资源**：
  - 新建lima实例`xorabuild`，不动pabox的`frxbuild`。
  - windows测试机和pabox共用时，先确认它空闲。
  - 没有rust编译，单次三端出包预计占用不到10g临时空间（估计）。

### 2.1 每端冒烟清单

- 静默安装或解包，检查目录布局和校验和
- 启动、创建项目、新建线程
- 用fake acp agent跑一轮：文本流、工具调用、权限请求往返、diff展示、取消
- 用xora engine对mock模型服务跑一轮
- 应用包热更新和回滚演练（见12第9节）
- 重启后历史可读，草稿还在
- 卸载干净

## 3. 测试策略

| 层 | 工具 | 覆盖内容 |
|---|---|---|
| 单元 | vitest | 纯函数、怪癖钩子、计价、迁移、规则匹配 |
| 组件 | testing-library+jsdom | ui行为（不对源码做正则匹配） |
| 契约 | test-kit的fake acp agent | host和引擎之间：权限请求、取消、恢复、能力降级 |
| 供应商回归 | 录制回放（mock模型服务） | 各厂商的思考回传、tool_choice、采样参数、错误码；另外手动触发，用真实端点跑小样本（用户自己的key） |
| 端到端 | playwright（electron模式） | 新建线程→改文件→审批→审阅→回滚 |
| 更新与修复 | 自动化脚本 | 坏包→自动回滚→基线→修复模式 |
| 安全 | 专项用例 | 路径越界、恶意仓库、权限模式（见10） |
| 性能 | 基准脚本 | 启动时间、内存、长线程滚动 |

## 4. ci与发布

- **github actions**：跑lint、类型检查、测试和三端出包。它既是本地出包的对照，也是将来有证书后的签名环境。
- **版本与变更日志**：用changesets管理。
- **发布流程**：
  1. 生成应用包清单并签名。
  2. 上传到github releases和国内镜像。
  3. 灰度放量（见12）。
- **sbom**：继续用syft生成。

## 5. 签名与公证

- **mac**：需要开发者证书和公证。没有证书时，shell无法自动更新；应用包热更新不受影响。
- **windows**：需要代码签名证书，否则会被smartscreen拦截。
- 证书采购放到最后考虑。拿到证书之前，按"未签名预览"发布，并在文档里写清安装方法。
