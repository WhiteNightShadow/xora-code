# xora code

agent优先的编程桌面：按"项目→线程"组织任务，主管agent拆分和验收，性价比模型执行，三平台一致。

- 状态：1.0重写进行中，当前处在M0（骨架）。设计见[docs/design](docs/design/README.md)。
- 旧版（theia加grok build的0.2.x）保留在`legacy/theia`分支和`legacy/v0.2.10`标签。

## 开发

需要node 24和pnpm（`corepack enable pnpm`）。

```bash
pnpm install
pnpm dev          # 构建并启动桌面端
pnpm test         # 单元测试
pnpm typecheck    # 类型检查
pnpm lint         # biome检查
pnpm drill        # 热更新回滚和修复模式演练
pnpm package      # 在mac上交叉打出三端安装包，产物在apps/desktop/release/
```

## 目录

| 目录 | 作用 |
|---|---|
| `apps/desktop` | bootstrap（electron主进程）、preload、修复模式页面、打包配置 |
| `apps/ui` | 界面（react） |
| `packages/protocol` | ui和host之间的协议 |
| `packages/updater` | 应用包槽位、签名清单、启动健康检查策略 |
| `packages/host` | host进程（electron utility process） |
| `packages/ui-kit` | 设计令牌和基础组件 |
| `build` | 应用包组装与签名、演练脚本 |

## 启动与回滚

安装包里的bootstrap只负责启动和恢复；界面、host和以后的引擎都在签名的应用包里，可以单独更新。

- 启动时按"待生效更新→当前版本→最近一次正常→内置基线"的顺序选应用包，每次启动前校验签名和全部文件哈希。
- 同一版本连续两次没启动成功就标记为坏，换下一个；全部失败时进入修复模式。
- 修复模式的入口有三个：
  - 启动时加`--safe-mode`；
  - 应用菜单"帮助→重启到修复模式"；
  - mac程序坞菜单。
- 数据目录：mac是`~/Library/Application Support/xora-code`，windows是`%APPDATA%\xora-code`，linux是`~/.config/xora-code`。故意和旧版的`Xora Code`目录分开，互不影响。
