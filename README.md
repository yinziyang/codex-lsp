# Codex LSP。

通过官方 Plugin 给 Codex CLI 0.163.0 提供语义导航与同轮自动诊断。
插件包含以下组件。

- MCP 工具。
- Skills 技能入口。
- 自动诊断 Hooks。
- 内部 CLI 运行程序。
源码复用固定 pi-lsp 提交 `ff1004afc819c6f39d217949784c712c0e68ca0e`。
客户端源码核验固定为 `83086188ae0614bd882818ff1aa23f3194962012`，项目不修改 Codex 源码。

当前版本为 0.2.2，安装缓存黑盒验收与本次修复的三平台 CI 已通过。
各项能力与尚未解除的全面产品发布门槛见 [需求状态矩阵](docs/需求状态矩阵.md)、[兼容与效果报告](docs/兼容与效果报告.md) 和 [独立验收手册](VALIDATION.md)。

## 新机器安装与首次使用。

按以下顺序操作即可开始，无需克隆本仓库或执行 npm 构建。

### 1. 准备 Node 和 Codex。

本项目验证的运行环境如下。

- Node.js >=22.18，终端中的 `node` 必须满足此要求。
- Codex CLI 0.163.0，其他版本尚需核验兼容性。

在普通终端检查版本。

```sh
node --version
codex --version
```

尚未安装 Codex 时，按 [官方安装说明](https://developers.openai.com/codex/cli) 安装并完成登录。

### 2. 从 GitHub 安装插件。

在普通终端执行以下两条命令。

```sh
codex plugin marketplace add https://github.com/yinziyang/codex-lsp.git
codex plugin add codex-lsp@codex-lsp-local
```

- 不指定 `--ref` 会获取仓库默认分支，本仓库为 `main`。
- 需要固定版本时才在第一条命令后追加 `--ref <标签或提交号>`。
- 安装取得的是当时的快照，不会自动跟随 GitHub 后续提交更新。
- `codex-lsp-local` 是市场名称，其中的 `local` 不表示从本地源码安装。
- 已有同名市场时不要重复添加，更新流程见 [独立验收手册](VALIDATION.md)。

在普通终端确认插件已安装并启用。

```sh
codex plugin list --json --marketplace codex-lsp-local
codex plugin marketplace list --json
```

插件应显示 `installed: true` 和 `enabled: true`。
GitHub 市场来源应显示 `sourceType: git`，来源 URL 为本仓库。
本地缓存路径只是 Codex 下载插件的存放位置。

### 3. 在实际项目中启动新的 Codex 会话。

安装或更新后，退出此前加载旧插件的 Codex 会话，再启动新会话。
在普通终端切换到要写代码的实际项目目录。

```sh
cd "/你的项目绝对路径"
codex
```

也可以不切换目录，直接指定项目路径。

```sh
codex -C "/你的项目绝对路径"
```

不要用包含多个独立项目的父目录作为工作区，插件不会自动分析其中所有子项目。
普通项目默认自动授权，无需每个新项目执行 `authorize` 或重复确认语言服务器启动权限。

### 4. 首次启用自动诊断时信任 Hook。

在 Codex 聊天框输入以下命令，审阅并信任本插件的五类 Hook。

```text
/hooks
```

这是 Codex 对自动运行 Hook 的信任要求，安装插件本身不会代替这次确认。
信任记录按 Hook 定义内容保存，内容不变时无需每次启动或每个项目重复确认。
更新导致 Hook 定义变化时，需要重新审阅变化的 Hook。
具体机制见 [官方 Hook 信任说明](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)。

| 功能 | 未信任本插件 Hook 时 |
|---|---|
| 主动查询定义、引用、类型等 LSP 信息 | MCP 已连接且对应服务器可用时仍可使用。 |
| 查看服务器状态和安装服务器 | 仍可使用。 |
| 改代码后自动反馈诊断、结束回答前检查错误 | 对应 Hook 被跳过，无法自动运行。 |

### 5. 查看并准备所需语言服务器。

插件已经包含 MCP、Skills、Hooks 和内部运行程序，不需要额外安装独立的 codex-lsp 软件包。
各语言的语言服务器仍需在这台机器上可用，插件会优先复用已有工具链。
未安装的服务器可以通过本插件管理，具体支持方式见 [语言与资产](#语言与资产)。

在 Codex 聊天框输入以下技能入口查看状态。

```text
$codex-lsp:manage
```

需要安装时，直接告诉 Codex 需要哪一种语言服务器，例如输入以下内容。

```text
请安装并启用 Python 的 basedpyright，然后检查当前项目的语言服务器是否就绪。
```

Python 默认选择 pyright，basedpyright 默认关闭，两者选择一个即可。
需要 Python 实现跳转时可选择 basedpyright。
配置或安装变更完成后，重新启动 Codex 会话使新配置生效。

`$codex-lsp:manage` 和 `$codex-lsp:setup` 都是由 AI 执行的技能入口，不是直接执行的内置命令。
`$codex-lsp:setup` 是可选的首次检查入口，可以核对插件、MCP、Hook 和当前项目的服务器状态，不是每次使用的前置步骤。
发现可执行文件只表示已检测到，真实初始化成功后才表示就绪。

### 6. 正常写代码。

在 Codex 中直接提出代码任务，例如输入以下内容。

```text
请使用 LSP 查找这个函数的定义和引用，再修改调用方。
```

需要显式加载查询技能时，可以输入 `$codex-lsp:lsp`。
对应服务器可用时即可进行语义查询，已经信任的 Hook 会在工具执行后和回答结束前等时机反馈诊断。
自动诊断由 Hook 触发，不要求每次手动执行查询命令。

## 可选：安装无需 AI 的管理短命令。

只安装插件就能在 Codex 中使用 LSP，不执行本节不会影响 MCP 或 LSP 功能。
只有希望直接运行 `codex-lsp status` 等终端命令时，才需要额外注册一次短命令。
注册使用插件已经附带的程序，不下载另一个 codex-lsp 软件包。

### macOS 和 Linux。

以下命令使用当前 0.2.2 的安装缓存路径，支持默认 Codex 用户目录和已设置的 `CODEX_HOME`。
如果安装的是其他版本，先通过 `codex plugin list --json --marketplace codex-lsp-local` 查看版本，再替换路径中的 `0.2.2`。
在普通终端执行以下命令。

```sh
node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/codex-lsp-local/codex-lsp/0.2.2/dist/cli.js" command-install
export PATH="$HOME/.local/bin:$PATH"
codex-lsp status
```

`export` 只对当前终端及其子进程生效。
将 `~/.local/bin` 加入所用 Shell 配置的 PATH 后，新终端也能找到短命令。
安装器不会修改 Shell 配置，可用 `command-install --directory <目录>` 选择已有 PATH 中的用户可写目录。

- 短命令默认注册到 `~/.local/bin/codex-lsp`。
- 短命令固定注册时使用的 Node 可执行路径，需使用满足版本要求的 Node 执行注册。
- 插件更新后短命令会自动解析当前安装的插件版本，无需因插件版本变化重复注册。
- Node 的原路径被删除或迁移后，需要用新的合格 Node 再执行一次 `command-install`。

### Windows。

当前没有 Windows 短命令安装器，直接调用插件内 CLI。
以下 PowerShell 示例使用当前 0.2.2 的安装缓存路径，安装其他版本时相应替换版本号。

```powershell
$codexLspHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$codexLspCli = Join-Path $codexLspHome 'plugins/cache/codex-lsp-local/codex-lsp/0.2.2/dist/cli.js'
node $codexLspCli status
node $codexLspCli install python --server basedpyright
```

### 注册短命令后的日常操作。

以下普通终端命令适用于已注册短命令的 macOS/Linux。
Windows 将 `codex-lsp` 替换为 `node $codexLspCli`。

| 目的 | 普通终端命令 |
|---|---|
| 查看各服务器状态表格 | `codex-lsp status` |
| 交互选择并安装 Python 服务器 | `codex-lsp install python` |
| 直接安装并启用 basedpyright | `codex-lsp install python --server basedpyright` |
| 直接安装并启用 pyright | `codex-lsp install python --server pyright` |
| 检查实际项目是否就绪 | `codex-lsp doctor --workspace /项目绝对路径` |
| 查看运行实例 | `codex-lsp instances` |

Codex CLI 聊天框使用内置 Shell 入口 `!` 执行同一命令，无需 AI 规划。
聊天框中使用非交互参数，不执行需要交互选择的 `install python`。

```text
!codex-lsp status
!codex-lsp install python --server basedpyright
!codex-lsp doctor --workspace /项目绝对路径
```

| 聊天框输入 | 执行方式 |
|---|---|
| `$codex-lsp:manage` | AI 执行技能，安装插件即可使用。 |
| `!codex-lsp status` | 直接执行本机短命令，需要先注册短命令。 |
| `/codex-lsp:status` | 当前 Codex CLI 不支持插件注册此类内置斜杠命令。 |

`status` 表格显示服务器启用状态、是否检测到可执行文件及其路径，不能代替 `doctor` 的真实初始化检查。
`install python --server ...` 安装并验证成功后启用所选服务器，关闭另一条 Python 路由。
配置变更后重新启动 Codex 会话生效。

## 高级管理。

以下命令以已注册的 macOS/Linux 短命令为例。
未注册短命令时，通过安装目录中的 `dist/cli.js` 执行相同子命令，也可以让 `$codex-lsp:manage` 协助管理。

```sh
codex-lsp plan go
codex-lsp install go --workspace /项目绝对路径
codex-lsp enable basedpyright
codex-lsp disable html
codex-lsp configure go --json '{"enabled":false}'
codex-lsp restart --instance INSTANCE_ID --workspace /项目绝对路径
codex-lsp uninstall basedpyright
```

- 安装计划会列出固定版本、来源、目标目录和副作用。
- 卸载不会删除用户已有工具，正在使用的私有资产会拒绝卸载。
- 重启必须明确目标 Core 与工作区，不创建管理端自己的 Core 来冒充旧连接。
- 配置变更在新启动的 MCP 进程中应用。
- 普通项目自动授权不改变宿主文件系统与执行权限，LS 仍可能读写项目、联网或执行构建脚本。
- 项目 `.codex-lsp.json` 自定义命令、参数与环境覆盖需要执行 `trust-project` 信任当前内容摘要，内容变化后重新审阅。

如需恢复逐项目授权，可显式切换模式，已有授权记录仍保留。

```sh
codex-lsp authorization explicit
codex-lsp authorize --workspace /项目绝对路径
codex-lsp authorization auto
```

授权模式变更后重新启动 Codex 会话生效，项目自定义启动命令的 `trust-project` 校验不受该开关影响。

## LSP 查询与诊断细节。

- 定义、引用、类型、文档、符号、实现和调用关系优先调用 `lsp`。
- `lsp` 的行列为一基 UTF-16，工作区根必须是项目绝对路径。
- 服务器明确不支持时返回 `Unsupported`，空语义结果返回 `Empty`。
- 调用层级先 `prepareCallHierarchy`，再用本线程的候选标识查询 incoming 或 outgoing。
- 大结果通过 `lsp_detail` 分页。
- 自动诊断由同一 MCP 连接上的五类 Hook 触发。
- 单批反馈最多十条每文件、三十条总量和八千 UTF-8 字节，摘要和完整详情分别记账。
- `diagnostics_remaining` 获取余项，`diagnostics_detail` 查看原始诊断。
- `lsp_manage` 生成只读管理计划，安装与卸载通过终端 CLI 或 Skill 执行。

## 语言与资产。

| 服务器 | 发现与安装 |
|---|---|
| gopls | 优先现有 Go 工具，安装固定 v0.22.0 到私有 GOBIN，使用 Go checksum database。 |
| rust-analyzer | 优先现有组件，新增时要求固定官方发行 URL、版本及 SHA256，不修改 rustup。 |
| clangd | 复用系统工具，提供三平台安装指引，不自动执行系统包管理器。 |
| TypeScript | 项目 TS <7 使用 typescript-language-server，>=7 尝试对应 tsc LSP，入口失败明确报错。 |
| pyright | Python 默认服务器，固定私有 npm 资产，默认 Push，不强制 Pull。 |
| basedpyright | 默认关闭，可通过 `install python --server basedpyright` 安装并启用，支持 Python 实现跳转。 |
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
codex-lsp purge
codex plugin remove codex-lsp@codex-lsp-local
codex plugin marketplace remove codex-lsp-local
```

`purge` 保留配置，拒绝清理无法核实归属或仍被占用的资产。
操作前关闭使用本插件的测试会话，保存同版本 CLI、guard.js 和 build-info.json。
禁用与恢复步骤见 [VALIDATION.md](VALIDATION.md)。

## 从源码开发与验证。

仅修改或开发本插件时需要克隆源码，普通用户按前面的 GitHub 安装流程使用。
在本仓库根目录执行以下命令。

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
node dist/plugin-install.mjs
```

- 安装助手只操作 `codex-lsp-local` 中的本插件，冲突时拒绝替换。
- 原用户配置和已验证旧包备份到 Codex 用户目录内的 `plugin-backups/codex-lsp/`。
- 安装助手执行前会校验 CLI 和守护产物的 SHA256。
- 无需开发依赖的离线清理入口为 `plugins/codex-lsp/dist/cli.js`。
- 本插件已经包含 MCP 注册信息，不要另行执行 `codex mcp add`。

源码开发时可用 `node plugins/codex-lsp/dist/cli.js <子命令>` 执行包内 CLI。
执行以下命令验证实现。

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
codex-lsp restart clangd --instance INSTANCE_ID --workspace /absolute/project
codex-lsp restart ts --instance INSTANCE_ID --workspace /absolute/project
```

指定Server或语言别名时，范围为目标Core、显式工作区内该Server的全部项目根。
例如ts统一为typescript，同工作区两个TS项目根均重启，clangd及另一个Core不变。
省略Server保留原全工作区重启行为。
未知Server、多余定位参数、重复标志或不属于目标Core的工作区均明确失败，不能退化成全部重启。
只失效被重启实例的调用层级项与语义详情缓存。
协议1旧连接不支持Server定位，需新启动插件连接，详见 [控制协议](docs/控制协议.md)。

## 语言服务器能力与限制。

以下能力受所选服务器实现限制，完整验收范围与发布门槛见 [独立验收手册](VALIDATION.md)。
Python默认仍选择pyright，原有pyright配置键和python语言别名不变。
需要继承实现跳转时，可以通过 Python 安装入口选择固定 basedpyright 1.40.2。

```sh
codex-lsp install python --server basedpyright
```

- basedpyright是独立的规范Server标识，默认关闭。
- 显式启用basedpyright后，该工作区默认pyright路由关闭，不运行两个Python服务器争抢同一扩展名。
- 同时显式启用两者会明确失败，用户显式禁用仍为项目配置上限。
- basedpyright的settings使用其官方命名空间，不自动改写原pyright配置。
- 配置变更需要新插件进程，`install python --server basedpyright` 会选择 Python 路由，单独 `install basedpyright` 只安装资产。
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
- Hook 和后台扫描对尚未回应的通道在总预算内等待，对已收到的无版本结果只额外等待100ms，不将等待结束当作分析完成或修复成功。
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
