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
- **出包**：都在本机mac上出，`node build/package.ts [目标…]`。六个目标是mac、windows、linux各x64和arm64，共10个安装包：mac的dmg和zip，windows的nsis，linux的AppImage和deb。
  - 脚本先`pnpm build && pnpm bundle`，再逐个目标调electron-builder，最后写`release/SHA256SUMS`。
  - 每个windows安装包都核对里面的应用压缩包没用ARM64过滤器。安装器自带的解压插件读不了这个过滤器，装完会缺所有exe和dll，安装器却照样报成功；pabox在electron-builder 26.15上遇到过。
  - 10-31全部出一遍约7分钟，release目录约2.9g。
- **语言包**：`electronLanguages`只留en-US、zh-CN、zh-TW。这些只用于chromium自带的文案，界面语言用的是自己的词典。mac arm64的dmg从128mb降到117mb，装好后从317mb降到270mb。
- **fuses**：打包时翻转，见10第6节。打包后的冒烟（`node build/ui-smoke.ts --app <exe>`）会复制一份应用，只把调试参数那根fuse打开再跑，因为playwright要经node调试端口驱动electron；更新演练直接跑正式包。
- **验证**：在虚拟机里装包、跑更新演练和界面冒烟，再卸载，见2.3节。
  - **mac**：在本机跑。
  - **linux**：`build/vm/linux.sh arm64|x64`。
  - **windows**：`build/vm/windows.sh arm64|x64`。
- **资源**：
  - lima实例`xorabuild`：ubuntu 24.04，4核、6g内存、30g磁盘，10-31建好。pabox的`frxbuild`不动。
  - windows测试机和pabox共用，脚本开始前先确认没有验收任务在跑。
  - 没有原生编译，出包只占release目录那2.9g。

### 2.1 每端冒烟清单

- 静默安装或解包，检查目录布局和校验和
- 启动、创建项目、新建线程
- 用fake acp agent跑一轮：文本流、工具调用、权限请求往返、diff展示、取消
- 用xora engine对mock模型服务跑一轮
- 应用包热更新和回滚演练（见12第9节）
- 重启后历史可读，草稿还在
- 卸载干净

### 2.2 能不能在linux上出多端（2026-10-31评估）

能出linux和windows的包，出不了mac的包，也没有比在mac上出更省事的地方。所以不建linux出包机，六个目标都在mac上出，虚拟机只用来验证。

- **原生模块不用编译**：node-pty自带六个目标的n-api预编译，`npmRebuild: false`。所以在哪台机器上都是拷文件，没有“必须在目标系统上编译”的限制。pabox的内核要在lima容器里交叉编译，xora没有这一步。
- **windows安装包**：
  - electron-builder 26.18改exe资源用的是js（`resEdit`），三个平台都不需要wine。
  - 但nsis的卸载程序要从生成的安装器里取出来：在mac上用js读，在linux上要用wine运行安装器。
  - arm64的linux跑不了x86的wine，得再套一层amd64容器。
- **linux安装包**：在mac上出的deb在虚拟机里装上跑通了（见2.3节）。在linux上出是electron-builder的原生用法，这次没有试。
- **mac安装包**：dmg要用hdiutil，签名和公证要用苹果的工具，只能在mac上出。

### 2.3 虚拟机验证（2026-10-31）

先在mac上运行`node build/vm/harness.ts`，生成测试工具：
- 冒烟和演练各打成一个文件，旁边带上playwright-core；
- 演练要用的更新包在mac上先签好，所以开发签名私钥不出本机。

每台机器上的流程：
1. 静默安装；
2. 跑更新演练（直接跑装好的应用）；
3. 跑界面冒烟（复制一份打开调试fuse的应用）；
4. 静默卸载，检查有没有残留。

结果放在`dist/vm-out/`。

| 安装包 | 机器 | 安装 | 更新演练 | 界面冒烟 | 卸载 |
|---|---|---|---|---|---|
| mac arm64 | 本机 | — | 8/8 | 16步 | — |
| windows arm64 | arm64测试机（hvf） | 31秒，333mb | 8/8 | 16步 | 无残留 |
| windows x64 | arm64测试机（prism转译） | 20秒，334mb | 8/8 | 16步 | 无残留 |
| windows x64 | x64测试机（tcg） | 104秒，334mb | 8/8 | 16步 | 无残留 |
| linux arm64 | xorabuild | deb，287mb | 8/8 | 16步 | 无残留 |
| linux x64 | xorabuild（rosetta） | deb，283mb | 8/8 | 16步 | 无残留 |
| linux arm64、x64 | xorabuild | AppImage，免安装 | 只查启动：能启动到“可用”，沙箱是关的 | — | — |

表里是这一轮的包，应用代码同`ab88f69`，AppImage是换静态启动器后重出的。界面语言改成跟随系统后又跑了一轮：mac arm64、windows arm64、linux arm64和x64都是演练8/8、冒烟18步（新加两步语言检查）；windows x64的新包没跑完，先把功能做完再统一验证。六个可执行文件的fuses都核对过：只开着cookie加密、asar完整性校验、只从app.asar加载。

- **linux**：ubuntu 24.04限制普通程序创建用户命名空间（`apparmor_restrict_unprivileged_userns=1`）。
  - deb装了apparmor配置，`chrome-sandbox`不需要setuid，演练跑的是带沙箱的正式应用。
  - 冒烟跑的是复制出来的那份，它不在apparmor配置覆盖的路径上，所以加了`--no-sandbox`。
  - AppImage只检查能不能启动到“可用”。它没有apparmor配置，electron-builder的AppRun发现建不了用户命名空间，就自动加`--no-sandbox`，所以在ubuntu 24.04上能跑但没有沙箱。xora的预览面板会加载任意网页，这些系统上应该推荐deb。
  - x64包靠rosetta跑。rosetta在binfmt里的规则要求ELF头第8到15字节为0，AppImage在那里写了自己的标记，所以`linux.sh`在虚拟机里另加了一条规则；真的x64机器不需要这一步。
  - lima每次启动虚拟机都会换一个cloud-init实例id，cloud-init随之重写`ubuntu.sources`，限定arm64的那行就没了，apt再去ports.ubuntu.com取amd64的索引会报404。`linux.sh`现在每次运行都把这行补回去。
- **windows**：
  - 测试机是pabox的，这里只用`C:\xora`和计划任务`XoraSmoke`；
  - 冒烟和演练放在登录桌面会话里跑，经ssh（会话0）开不了窗口；
  - 跑完只留node和MinGit给下次用。
  - x64测试机是tcg模拟，超时放大6倍，一轮演练加冒烟约45分钟。
  - arm64测试机上装x64包时卡死过一次：安装器是x86程序，它在安装前用powershell查应用是否在运行（electron-builder自带的检查），拉起的是x86的powershell，在prism下满负荷空转了25分钟。手动结束后重跑，同样的检查只用了几秒，原因没查清。
- **查出并修掉的问题**：
  - AppImage换成静态启动器（`toolsets.appimage: "1.0.3"`，测试版）。默认的appimage-12.0.1要libfuse2，ubuntu 24.04默认不装；它的arm64启动器还链接了不带版本号的`libz.so`（只有zlib的开发包才有），在虚拟机里直接起不来。
  - deb少依赖`libasound2`和`libgbm1`。桌面版系统一般都装着，服务器版和精简安装没有，应用直接起不来。
  - `libasound2`在ubuntu 24.04上是虚拟包，apt挑了`liboss4-salsa-asound2`来满足它，里面缺electron要的符号。所以依赖写成`libasound2t64 | libasound2`。
  - 终端面板缺`min-width: 0`，终端的宽度把自己的容器撑开了，每次自适应都缩几像素。linux的滚动条要占宽度，暴露了这个问题；三个平台都受影响。
  - 冒烟脚本本身：`mkdir -p`换成node的mkdir，终端命令分powershell和posix两种写法，windows上删临时目录要重试（应用刚退出时子进程还占着exe）。
- **界面语言**：10-31改成默认跟随系统，见03第5节。
  - 冒烟按中文按钮名找控件，所以用`--lang=zh-CN`把应用语言固定成中文。最后两步另起一个`--lang=en-US`的干净实例，查界面和菜单是英文，在设置里改成简体中文后两者都跟着变。
  - 更新演练不加`--lang`。windows测试机的系统语言是en-US，修复模式页面在那里显示英文，演练照样通过。

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

- **github actions**：在ubuntu、macos、windows上跑lint、类型检查、测试和构建，不出安装包。安装包都在本机出（2026-10-31用户定），见第2节。
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
