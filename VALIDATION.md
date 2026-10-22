# 独立安装验收手册。

实施者的开发 smoke 不能替代本手册的独立验收。
由协调者在安装后启动全新验证 Codex，每轮结束关闭该验证 Codex。
失败交回同一实施会话修复，修复后重新安装明确的新版本并启动全新验证 Codex。
不得修改 Codex 源码、关闭 Hook 或手工写信任摘要。

## 固定输入。

- Codex CLI 为 0.163.0，核对 `codex --version`。
- Codex 源码基线为 `83086188ae0614bd882818ff1aa23f3194962012`。
- 上游 pi-lsp 基线为 `ff1004afc819c6f39d217949784c712c0e68ca0e`。
- Node 为 >=22.18，Windows 使用原生 Node 和原生语言服务器。
- 版本、源码摘要及两个 bundle 摘要读取 `plugins/codex-lsp/dist/build-info.json`。
- 独立验收记录 Git commit、操作系统、架构、Node、Codex、LS 二进制版本和 build-info 原文。
- 运行目录使用个人可丢弃夹具，禁止使用真实密钥或私有项目。

## 安装。

先备份用户 Codex 配置及本插件旧缓存到用户独占目录。
不要把备份、账户配置或 runtime 文件提交远端。
已有同名独立 MCP 时报告冲突，不自动删除。
全新市场可执行下列命令，其中 COMMIT 必须替换为交付记录的完整 Git 提交。

```sh
codex plugin marketplace add https://github.com/yinziyang/codex-lsp.git --ref COMMIT
codex plugin add codex-lsp@codex-lsp-local
codex plugin list --json --marketplace codex-lsp-local
```

同名本地市场需先核实只包含本插件，保存旧包、原市场来源与 enabled 状态，再移除该市场并添加固定 Git 来源。
不可用本地缓存安装冒充远端安装。
可在隔离 CODEX_HOME 无模型账户的情况下先验证市场快照和包内容。

本地测试安装可用 `node dist/plugin-install.mjs`。
更新前先 `npm run build`，两次无源码改动构建结果须一致。
安装后必须在新进程确认实际 MCP serverInfo 中的源码哈希与 build-info 一致。
`codex plugin list`、磁盘版本或旧会话工具列表单独均不能证明新构建已加载。

## B1 整包与信任。

1. 确认安装源为本次固定 Git commit。
2. 新启动 Codex，确认五个公共 MCP 工具和五个内部 Hook 入口已发现。
3. 确认 setup、lsp、manage 三个 Skills 来自本插件。
4. 在 `/hooks` 正式审阅 PreToolUse、PostToolUse、Stop、SubagentStop、UserPromptSubmit。
5. 保存本插件的发现记录和信任状态，剔除其他插件和账户信息。
6. 运行 setup，分别记录 enabled、trusted、connected、feedback。
7. 负例为未信任、策略禁用、MCP 断开，必须明确反馈不可用，不得记录成功。

固定客户端使用官方 Legacy manifest，原因见 `docs/ADR-001-客户端包装兼容.md`。
正式 portable AgentPlugin 在固定版本不发现 Hook，不能以通过其 schema 来代替 B1。

## B2 同轮反馈。

先创建有效 C 文件并授权夹具根目录。
每项使用新文件或明确快照，保存完整事件 JSONL、文件前后摘要、原始 LS initialize 与 publishDiagnostics。
只读日志可能包含源代码，不公开原始私有数据。

1. 要求模型只使用一次 apply_patch 引入未定义标识符，随后不主动调用 MCP，并逐字引用本轮自动收到的诊断。
2. 使用 Shell 成功写入同样错误，检查本轮模型实际读取。
3. 使用 Shell 部分写入后退出码1，检查 PostToolUse 仍对账并反馈。
4. 控制诊断延迟到 PostToolUse 之后、Stop 之前就绪，检查 Stop 补偿最多延续一次。
5. 父子线程共享 session_id、不同宿主 threadId，控制子诊断在 SubagentStop 前就绪，检查子队列不被父消费。
6. 伪造 agentId 与宿主 threadId 不一致必须拒绝。
7. 用户中断、正常结束、已续轮 Stop 和宿主强杀均保存退出时间与进程树。

不能把工具已安装、模型主动查询诊断、下一轮才收到或仅日志出现错误当作同轮通过。
不能把实施者的开发 Codex 轨迹冒充独立验证。

## B3 诊断可信度。

运行 `npm test`，再用可控 Push/Pull 服务记录下列状态转换。

- 历史 A 保留并新增 B，只报 B。
- 首次无基线的 A 必须展示，归因写未知。
- 同线程跨轮不重报，另一线程首次独立观察。
- 版本旧推送、无版本 Push、unchanged、完整空、慢通道分别处理。
- 一路为空而另一路超过八秒仍待分析时不能报全部修复。
- 多文件、快速编辑、删除、重命名、同 mtime/size 修改和扫描分页均有对账。
- 超大中文及 emoji 诊断最终文本不超过八千 UTF-8 字节。
- 摘要不冒充详情已送达，余项游标可读且重放幂等。
- 检查宿主实际模型可见文本没有触发 spill，模拟预算测试不足以证明宿主文本通过。

运行 `npm run test:real` 和 `scripts/real-matrix.mjs`。
矩阵必须展开八条服务器路径的九操作，Supported、Unsupported、Failed、NotTested 分开。
检查原始响应与规范化结果的 URI、UTF-16 坐标、过滤及截断。
TypeScript>=7 若无可验证入口保持 NotTested，不能伪造 Supported。

## B4 原生平台和资产。

macOS、Linux、Windows 分别在原生系统执行，不以 WSL 或模拟平台参数代替。

1. 固定版本私有安装 Go、TS、Python、HTML/CSS，保存来源、SRI/校验和、锁文件与真实 initialize。
2. Rust 使用官方固定发行资产和 SHA256，不修改用户 rustup。
3. clangd 复用系统安装，缺少时显示平台指引。
4. HTML 先卸载而 CSS 仍工作，之后最后消费者移除才删除共享资产。
5. 校验失败、下载失败、取消、错误版本和磁盘写入失败均不得破坏旧资产。
6. 用户工具、外部 rustup 组件和无所有权目录不能被 purge。
7. Windows 原生覆盖 PATHEXT、Path、cmd/bat 到真实解释器映射、Python Scripts、空格路径、ACL、任务树退出和 PID 复用保护。
8. 宿主 SIGKILL 后忽略 EOF 的 LS 必须由私有守护有界清理，未知归属资产保留并报告。

GitHub hosted runner 的测试只证明实际执行的用例，不等于带账户的真实 Agent 安装验收。

## B5 更新和多实例。

1. 运行 `npm run test:install`，确认真实旧构建0.0.9升级到当前版本。
2. 在用户独占测试配置内禁用本插件，再更新，确认 enabled=false 保留。
3. CLI 0.163.0 没有 plugin disable 子命令，可通过宿主 Plugin 管理禁用或在测试配置原子更新本插件 enabled 字段。
4. 临时 CLI override 必须用 `-c 'plugins.codex-lsp@codex-lsp-local.enabled=false'`，不要在 dotted key 中加引号。
5. 先用 `codex plugin list --json` 核验 override 确实生效，再启动对照任务。
6. 新进程确认禁用后无本插件 MCP、Skills 和 Hooks，旧会话边界须明确记录。
7. 两个会话同工作区分别启动 Core，列出 instanceId、PID、启动身份和配置摘要。
8. 指定一个 instanceId 与工作区重启，另一个保持原代次。
9. 跨线程调用层级标识与诊断游标不能复用，重启旧标识必须 Stale。
10. 损坏配置迁移不得覆盖原文件，恢复私有备份后重新安装旧验证包。
11. Plugin remove 后保留私有数据，用保存的同版本 CLI 显式 purge，再检查其他用户工具未变。

## 效果与性能。

至少重复两次相同模型、推理等级、任务和夹具的开启与关闭对照。
保存每轮模型版本、工具调用、输入 Token、耗时、符号定位、错误发现与修复结果。
关闭组实际调用了本插件时整组作废，不能计算“插件提升”。
当前开发小样本只用于链路和测量脚本核验，不足以代表通用编程收益。
桥接开销需与同进程直接 LS 对照，不能用 MCP 总耗时代替。

## 结束与恢复。

验证者先提交验收报告和 worker_done，随后停止操作。
协调者立即关闭本轮验证 Codex 并核实退出，再安排下一轮全新进程。
失败记录明确版本、commit、构建摘要、复现命令及原始证据，禁止留下验证进程继续用旧缓存运行。
移除命令为 `codex plugin remove codex-lsp@codex-lsp-local`。
清理市场命令为 `codex plugin marketplace remove codex-lsp-local`。
恢复时仅恢复本插件条目、其市场及已验证缓存，不覆盖其他会话新增的用户配置。

## F01指定Server重启回归。

使用0.1.4构建后执行 `node scripts/restart-validation.mjs`，可用CODEX_LSP_EVIDENCE指定独立证据目录。
脚本启动两个真实Core，每个Core包含clangd和两个独立项目根的TypeScript服务器。

1. `restart clangd --instance <A> --workspace <根>`只改变A中clangd的PID与代次。
2. `restart ts --instance <A> --workspace <根>`改变A中两个TS项目根，clangd和Core B保持。
3. 省略Server则重启A中该工作区全部Server，Core B仍保持。
4. 无效Server、重复定位标志、多个Server、未知参数、错误实例和错误工作区必须失败，前后状态完全不变。
5. 检查旧调用项与详情只在所属实例重启后Stale，其他Server和Core仍可使用。
6. 协议1旧Core收到Server定位意图须Unsupported，不能忽略定位字段执行全工作区重启。

自动化 `tests/restart.test.ts` 使用可控协议与真实子进程补充缓存、协议身份和无效目标断言，不冒充真实语言服务器。
0.1.4控制协议与版本边界见 `docs/控制协议.md`。

## 原生子线程开发探针。

`node scripts/native-thread-probe.mjs`要求CODEX_LSP_PLUGIN_CLI显式指向已安装插件CLI，不从源码目录冒充安装。
CODEX_LSP_EVIDENCE指定自有夹具和证据目录，CODEX_LSP_NATIVE_MODE可为v1或v2。
仅在被测Codex本次命令内启用原生工具，配置不写入用户全局文件。
必须保存实际工具表搜索、原生ThreadSpawn子threadId、成功文件编辑和SubagentStop协议记录。
模型自述已使用原生工具、/root任务路径或合成代理结果都不足以证明通过。
原生工具不可发现时保留源码、CLI功能与实际搜索证据，不能改用合成代理宣布成功。

CODEX_LSP_NATIVE_MODE=v2使用features.multi_agent_v2结构配置及non_code_mode_only=true，工具直接暴露给模型，不能用根multi_agent_v2字段替代。
探针thread-evidence.json分别记录nativeThreadSpawnObserved及subagentStopObserved，前者为真不代表后者通过。
子线程继承MCP工具可见性与执行Hook是不同条件，须按子threadId核对实际调用日志。

TypeScript 7本机补证可运行 `CODEX_LSP_MATRIX_SERVER="tsc LSP" CODEX_LSP_EVIDENCE=<新目录> node scripts/real-matrix.mjs`，再用相同证据目录运行 `node scripts/verify-matrix.mjs`。
脚本仅在tsc报告主版本至少7时添加该路径，并通过明确tsc命令及--lsp、--stdio参数与TS5入口区分。
固定版本、可执行文件来源和摘要仍须单独保存，不只凭initialize版本自报判断成功。

## 0.2.0候选新增能力独立验收。

必须先按候选完整Git提交安装Plugin并新启动宿主，核对版本及sourceHash，不从main假定取得候选代码。
复用满足Node>=22.18的显式PATH，不改全局Node或nvm。
完整保留原八路径72格基线，候选新增结果另记，不将原Supported-empty计作新增语义成功。

```sh
CODEX_LSP_PLUGIN_CLI=/absolute/installed/plugin/dist/cli.js CODEX_LSP_LLVM_CLANGD=/absolute/verified/llvm/clangd CODEX_LSP_EVIDENCE=/absolute/new/evidence node scripts/capability-validation.mjs
```

该脚本仅在自有数据根安装固定basedpyright，不写用户全局配置。
LLVM可执行文件须已受信且固定版本，脚本记录实际版本、参数及SHA256，不下载或替换系统LLVM。

1. Python必须返回Child.work的实际URI及子类方法range，与原始implementation响应比较，仅含Base不通过。
2. C和.cpp使用不同符号名及各自编译参数，出向调用必须命中各自callee的真实URI与range，不能只看非空。
3. .cpp另须命中虚方法继承的实现位置。
4. HTML和CSS均须覆盖至少两个文件、query筛选、修改与删除，聚合结果与逐文件原始documentSymbol按真实位置比较。
5. 断言workspaceSymbol原生capability未被修改，聚合结果必须标明source。
6. 纯HTML/CSS实现跳转和调用层级仍须明确Unsupported。
7. 完整回归中的定向用例覆盖gitignore、root隔离、链接替换、FIFO或目录替换、取消、畸形符号及资源预算，不以模拟用例替代上述真实LS结果。
8. 核对Core、LS及guard有界退出，私有basedpyright资产按所有权清理，pyright原工具不受影响。

候选本机能力通过也不等于原生SubagentStop或Linux、Windows带账户Agent全矩阵通过。
原生ThreadSpawn已证实，子Hook未观察到且归因未明，原P0门槛保持。

紧凑响应预算回归运行 `node --test tests/capabilities.test.ts tests/semantic-output.test.ts tests/core.test.ts`。
128文件上限的原始警告必须在首包保留，中文与emoji警告最多显示3条且每条100个Unicode码点，省略和缩短数量须可见。
首包最终JSON序列化不得超过32000个UTF-8字节，不能仅比较JavaScript字符串长度。
保留长query拒绝、完整分页及跨线程隔离，无详情缓存时也必须满足相同首响应上界。
