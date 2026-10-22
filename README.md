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

### 从 GitHub 市场安装。

首次安装可直接添加 GitHub 仓库中的插件市场，无需克隆源码或运行 npm 构建。

```sh
codex plugin marketplace add https://github.com/yinziyang/codex-lsp.git --ref main
codex plugin add codex-lsp@codex-lsp-local
codex plugin list --json --marketplace codex-lsp-local
```

- `codex-lsp-local` 是仓库声明的市场名称，名称中的 `local` 不表示市场来自本地目录。
- 市场来源为 GitHub Git 仓库，Codex 下载后显示本地缓存路径。
- `--ref` 是可选参数，可指定分支、标签或完整提交号。
- `--ref main` 获取添加市场时的 main 分支快照，不代表后续自动更新。
- 需要复现已验收的 0.2.0 版本时，将 `main` 替换为 `1484bd4f21a115fd18d077137158c3a8e3194908`。

可用下列命令核对实际市场来源。

```sh
codex plugin marketplace list --json
```

GitHub 安装的市场应显示 `marketplaceSource.sourceType` 为 `git`，且 `marketplaceSource.source` 为上述仓库 URL。
已有同名市场或已安装本插件时，不要重复添加市场，更新与独立验收流程见 [VALIDATION.md](VALIDATION.md)。

### 从源码进行本地开发安装。

在本仓库根目录执行下列命令。

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

### 安装后首次使用。

安装或更新后关闭测试 Codex，再新启动进程。
在 `/hooks` 正式审阅五类 Hook。
插件启用不代表 Hook 已信任，也不代表 MCP 已连接或自动反馈已被模型读取。
在新 Codex 会话中使用本插件的 setup 技能检查语言服务器与连接状态。
普通项目默认自动授权，无需逐项目确认或手动运行 authorize。
下列手动 CLI 示例需在源码仓库根目录执行，GitHub 市场安装可通过 setup 技能完成配置。

```sh
node plugins/codex-lsp/dist/cli.js doctor --workspace /absolute/project
```

LS 可以读写工作区、联网或执行项目构建脚本，自动授权不改变宿主的文件系统与执行权限。
项目 `.codex-lsp.json` 的命令、参数、环境等覆盖配置只有经 `trust-project` 对当前内容摘要授权才执行。
内容变化需要重新审阅。

### 无需 AI 的终端管理。

macOS/Linux 用户只需安装一次用户级短命令，命令自动跟随当前 Codex 已安装插件版本，无需每次输入插件缓存路径。
从源码开发时在仓库根目录运行下列命令，GitHub 市场安装时将 CLI 路径替换为插件安装目录中的 dist/cli.js。

```sh
node plugins/codex-lsp/dist/cli.js command-install
codex-lsp status
codex-lsp install python
```

- 默认安装到 `~/.local/bin/codex-lsp`，该目录需已在 PATH 中，可通过 `--directory` 指定其他用户可写目录。
- 命令固定安装时的 Node 可执行路径，避免默认 Shell 中的旧 Node 导致启动失败，不修改 Node 默认版本或 Shell 配置。
- `status` 用表格分别显示每个服务器的启用状态、是否检测到可执行文件及其路径，发现可执行文件不等于真实初始化成功。
- `install python` 交互选择 basedpyright 或 pyright，安装并验证成功后启用所选服务器并关闭另一条 Python 路由。
- 非交互脚本使用 `codex-lsp install python --server basedpyright` 或 `--server pyright`，不隐式选择或等待输入。
- 其他语言直接使用 `codex-lsp install go` 等已有语言别名，服务器安装来源与限制见下文。
- Windows 暂使用 `node <插件根>/dist/cli.js status` 等相同子命令，尚不提供用户级短命令安装器。

```sh
codex-lsp enable basedpyright
codex-lsp disable html
codex-lsp doctor --workspace /absolute/project
codex-lsp uninstall basedpyright
```

配置变更后新开 Codex 会话生效，卸载不会删除用户已有工具，正在使用的私有资产会拒绝卸载。
如需恢复逐项目授权，可显式切换模式，已有授权记录仍保留。

```sh
codex-lsp authorization explicit
codex-lsp authorize --workspace /absolute/project
codex-lsp authorization auto
```

授权模式变更后新开 Codex 会话生效，项目自定义启动命令的 trust-project 校验不受该开关影响。

## 使用。

- 定义、引用、类型、文档、符号、实现和调用关系优先调用 `lsp`。
- `lsp` 的行列为一基 UTF-16，工作区根必须是项目绝对路径，普通项目默认自动授权。
- 服务器明确不支持时返回 `Unsupported`，空语义结果返回 `Empty`。
- 调用层级先 `prepareCallHierarchy`，再用本线程的候选标识查询 incoming 或 outgoing。
- 大结果通过 `lsp_detail` 分页。
- 自动诊断由同一 MCP 连接上的五类 Hook 触发，不要求模型主动查诊断。
- 单批反馈最多十条每文件、三十条总量和八千 UTF-8 字节，摘要和完整详情分别记账。
- `diagnostics_remaining` 获取余项，`diagnostics_detail` 查看原始诊断。
- `lsp_manage` 生成只读管理计划，安装与卸载可直接用终端 CLI，也可由 Skill 在宿主现有执行权限内运行。

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

## 0.2.0候选能力补齐。

本版本在候选分支接受独立验收，未据此解除全面产品发布门槛。
Python默认仍选择pyright，原有pyright配置键和python语言别名不变。
需要继承实现跳转时，先通过包内CLI安装固定basedpyright 1.40.2，再显式选择。

```sh
node plugins/codex-lsp/dist/cli.js install basedpyright --workspace /absolute/project
node plugins/codex-lsp/dist/cli.js configure basedpyright --json '{"enabled":true}'
```

- basedpyright是独立的规范Server标识，默认关闭。
- 显式启用basedpyright后，该工作区默认pyright路由关闭，不运行两个Python服务器争抢同一扩展名。
- 同时显式启用两者会明确失败，用户显式禁用仍为项目配置上限。
- basedpyright的settings使用其官方命名空间，不自动改写原pyright配置。
- 配置变更需要新插件进程，安装本身不切换服务器。
- 私有资产按固定npm完整性验证，移除该包额外生成的pyright命令别名，防止影响既有pyright选择。

C/C++出向调用可通过已验证的LLVM clangd支持，普通LLVM20及22源码默认启用EnableOutgoingCalls，没有独立CLI开关。
实际方法可用性仍以真实请求为准，Apple clangd17返回MethodNotFound时继续明确Unsupported。
可用现有configure clangd的command指定已安装LLVM可执行文件及args，不替换系统Apple clangd，不自动搜索或硬编码Homebrew路径。

HTML/CSS没有声明原生workspaceSymbol时，兼容聚合当前Server项目root内真实documentSymbol，输出source=documentSymbol-aggregation。

- 不修改服务器声明的capability，不把聚合标为服务器原生支持。
- query按符号名称大小写不敏感子串筛选，返回真实URI和range。
- 不跨其他项目root，不跟随符号链接，遵守固定忽略目录及项目内逐层gitignore。
- 沿用Core文档版本和同步，不另建版本1会话或关闭已有文档。
- 每次查询重新读取与比对，不复用过期文件快照。
- 单次最多10000目录条目、128候选文件、32层目录、16MB读取、单文件2MB、每文档10000符号，聚合限时10秒且响应取消。
- 超预算或读取失败返回complete=false及warnings，结果limit截断还报告omitted，不能当作完整工作区结果。
- 纯HTML/CSS实现跳转及调用层级仍Unsupported，不用文本搜索伪造语义。

完整新增能力复现入口见[验收手册](VALIDATION.md)。

query最多4096个UTF-8字节，超限在任何文件或服务器调用前明确拒绝。
聚合总结果另有2MB预算，超大响应仍保留source及complete=false，紧凑响应不复制任意长输入或完整路径。
紧凑响应最多保留3条真实warnings，每条最多100个Unicode码点，warningsOmitted表示未显示的条数，warningsTruncated表示可见警告中缩短的条数。
完整范围与完整警告仅在详情可用时分页读取，无详情缓存时仍保留有界的真实原因。
所有紧凑响应返回前按JSON序列化UTF-8字节数检查32000字节上界。

## 0.2.2 自动诊断范围与资源回收。

- 自动诊断遵守工作区内逐层 `.gitignore`，不跨入嵌套 Git 仓库。
- 有项目标记或顶层源码文件的目录才启动递归扫描与监听，普通父目录只监听顶层并提示选择实际项目，不遍历所有子项目和验收产物。
- 实际项目内部的 monorepo 子包仍纳入扫描，独立子仓库应作为单独工作区使用。
- 被忽略的文件明确报告移出诊断范围，不冒充物理删除或问题修复。
- 内置 clangd 保留后台索引，默认追加 `-j=2` 限制异步及索引工作线程，自定义命令或显式参数保持原样。
- 24个LS实例上限保留，空闲10分钟的实例成功停止后释放额度，停止失败不放弃所有权。
- 回收后重新创建实例使用新的代次，旧调用层级候选和语义详情不能重新生效。
- Hook 和后台扫描最多额外等待100ms诊断，未带版本的结果仍标记不确定，不将等待结束当作分析完成或修复成功。
- 服务器冷启动后重新读取文件，避免旧扫描快照倒退当前文档版本。

应在实际项目目录启动 Codex，父目录容器不会自动分析其下全部独立项目。

```sh
codex -C /absolute/project
```

需要自行设置 clangd 线程数时，可显式提供完整参数并新开 Codex 会话。

```sh
codex-lsp configure clangd --json '{"args":["--background-index","-j=4"]}'
```

线程数设置不是 CPU 利用率的硬配额，本版没有对进程已结束后的历史 CPU 峰值作原因认定。
