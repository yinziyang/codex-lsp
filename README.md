# Codex LSP。

通过官方 Plugin 给 Codex CLI 0.163.0 提供语义导航与同轮自动诊断。
安装单元包含 MCP、Skills、Hooks 和内部 CLI。
源码复用固定 pi-lsp 提交 `ff1004afc819c6f39d217949784c712c0e68ca0e`。
客户端源码核验固定为 `83086188ae0614bd882818ff1aa23f3194962012`，项目不修改 Codex 源码。

本项目是待独立验收的首个实施版本。
本机 macOS 开发验证不代表三平台发布验收通过。
发布门槛及逐条状态见 [需求状态矩阵](docs/需求状态矩阵.md) 与 [独立验收手册](VALIDATION.md)。

## 安装。

前置条件为 Node >=22.18 和 Codex CLI 0.163.0。
语言服务器使用已有工具链或本插件私有资产，不自动安装系统软件。

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
node dist/plugin-install.mjs
```

安装助手只操作 `codex-lsp-local` 中的本插件，冲突时拒绝替换。
原用户配置和已验证旧包备份到 Codex 用户目录内的 `plugin-backups/codex-lsp/`。
无需开发依赖的离线清理入口为 `plugins/codex-lsp/dist/cli.js`。
不要执行 `codex mcp add`。
安装助手执行前会校验 CLI 和守护产物的 SHA256。
远端安装使用 [VALIDATION.md](VALIDATION.md) 中固定 commit/ref 的 Git marketplace 流程。

安装或更新后关闭测试 Codex，再新启动进程。
在 `/hooks` 正式审阅五类 Hook。
插件启用不代表 Hook 已信任，也不代表 MCP 已连接或自动反馈已被模型读取。

```sh
node plugins/codex-lsp/dist/cli.js authorize --workspace /absolute/project
node plugins/codex-lsp/dist/cli.js doctor --workspace /absolute/project
```

授权前应了解 LS 可以读写工作区、联网或执行项目构建脚本。
项目 `.codex-lsp.json` 的命令、参数、环境等覆盖配置只有经 `trust-project` 对当前内容摘要授权才执行。
内容变化需要重新审阅。

## 使用。

- 定义、引用、类型、文档、符号、实现和调用关系优先调用 `lsp`。
- `lsp` 的行列为一基 UTF-16，工作区根必须是已授权的绝对路径。
- 服务器明确不支持时返回 `Unsupported`，空语义结果返回 `Empty`。
- 调用层级先 `prepareCallHierarchy`，再用本线程的候选标识查询 incoming 或 outgoing。
- 大结果通过 `lsp_detail` 分页。
- 自动诊断由同一 MCP 连接上的五类 Hook 触发，不要求模型主动查诊断。
- 单批反馈最多十条每文件、三十条总量和八千 UTF-8 字节，摘要和完整详情分别记账。
- `diagnostics_remaining` 获取余项，`diagnostics_detail` 查看原始诊断。
- `lsp_manage` 生成只读管理计划，安装与卸载由 Skill 引导原生 Shell 审批运行内部 CLI。

```sh
node plugins/codex-lsp/dist/cli.js list
node plugins/codex-lsp/dist/cli.js plan go
node plugins/codex-lsp/dist/cli.js install go --workspace /absolute/project
node plugins/codex-lsp/dist/cli.js configure go --json '{"enabled":false}'
node plugins/codex-lsp/dist/cli.js instances
node plugins/codex-lsp/dist/cli.js restart --instance INSTANCE_ID --workspace /absolute/project
node plugins/codex-lsp/dist/cli.js uninstall go
```

重启明确目标 Core 和工作区，不创建 manager 自己的 Core 来冒充重启旧连接。
配置变更在新启动的 MCP 进程中应用。

## 语言与资产。

| 服务器 | 发现与安装 |
|---|---|
| gopls | 优先现有 Go 工具，安装固定 v0.22.0 到私有 GOBIN，使用 Go checksum database。 |
| rust-analyzer | 优先现有组件，新增时要求固定官方发行 URL、版本及 SHA256，不修改 rustup。 |
| clangd | 复用系统工具，提供三平台安装指引，不自动执行系统包管理器。 |
| TypeScript | 项目 TS <7 使用 typescript-language-server，>=7 尝试对应 tsc LSP，入口失败明确报错。 |
| pyright | 固定私有 npm 资产，默认 Push，不强制 Pull。 |
| HTML 与 CSS | 固定 vscode-langservers-extracted 共享单元，消费者分别记录。 |

npm 直接包版本与官方 SRI 固定，事务中生成并核验 package-lock 后使用 `npm ci --ignore-scripts`。
间接依赖以安装事务的锁文件和摘要为准，不声称不同日期首次解析的全部间接依赖相同。
下载或 initialize 失败不提交新所有权。
卸载只操作本插件所有权目录，检查运行中 Core 与守护租约。
外部工具、rustup 组件、用户密钥及其他插件均不归本插件清理。

## 数据和卸载。

- macOS 默认数据目录为 `~/Library/Application Support/codex-lsp`。
- Linux 默认数据目录为 `${XDG_DATA_HOME:-~/.local/share}/codex-lsp`。
- Windows 默认数据目录为 `%LOCALAPPDATA%/codex-lsp`。
- `CODEX_LSP_DATA_HOME` 或 CLI `--data-root` 可指定绝对路径。
- 配置、资产、运行记录、所有权和日志分别存放于上述私有目录。
- `CODEX_LSP_TRACE=1` 开启原始协议日志，含项目内容和路径，默认关闭且不可直接公开。
- 插件直接 remove 后私有数据保留，须用同版本离线 CLI 显式清理。

```sh
node plugins/codex-lsp/dist/cli.js purge
codex plugin remove codex-lsp@codex-lsp-local
codex plugin marketplace remove codex-lsp-local
```

`purge` 保留配置，拒绝清理无法核实归属或仍被占用的资产。
操作前关闭使用本插件的测试会话，保存同版本 CLI、guard.js 和 build-info.json。
禁用与恢复步骤见 [VALIDATION.md](VALIDATION.md)。

## 开发与证据。

```sh
npm test
npm run test:real
npm run test:install
CODEX_LSP_EVIDENCE=/absolute/evidence node scripts/real-matrix.mjs
CODEX_LSP_EVIDENCE=/absolute/evidence node scripts/verify-matrix.mjs
```

`npm test` 包括固定上游回归、可控模拟协议、真实 clangd 和强杀生命周期用例。
测试要求真实 clangd 可发现，不会把缺少 clangd 当作成功。
`test:install` 使用隔离 CODEX_HOME，执行真实 Plugin 0.0.9 到当前版本更新、启禁保持和移除。
它不携带用户账户，也不证明同轮模型读取成功。
三平台 CI 的运行范围与发布剩余门槛记录于 [兼容与效果报告](docs/兼容与效果报告.md)。

Pi 入口为 `src/pi.ts`，通过同一 Core 提供工具、事件、状态、renderer 与管理命令。
原 `extensions/pi-lsp/index.ts` 保留上游参考和回归，不是当前包的生产入口。
Pi 真实 Agent 尚需独立宿主验收。
架构与复用边界见 [模块边界](docs/模块边界.md)。

## 指定Server重启。

```sh
node plugins/codex-lsp/dist/cli.js restart clangd --instance INSTANCE_ID --workspace /absolute/project
node plugins/codex-lsp/dist/cli.js restart ts --instance INSTANCE_ID --workspace /absolute/project
```

指定Server或语言别名时，范围为目标Core、显式工作区内该Server的全部项目根。
例如ts统一为typescript，同工作区两个TS项目根均重启，clangd及另一个Core不变。
省略Server保留原全工作区重启行为。
未知Server、多余定位参数、重复标志或不属于目标Core的工作区均明确失败，不能退化成全部重启。
只失效被重启实例的调用层级项与语义详情缓存。
协议1旧连接不支持Server定位，需新启动插件连接，详见 [控制协议](docs/控制协议.md)。
