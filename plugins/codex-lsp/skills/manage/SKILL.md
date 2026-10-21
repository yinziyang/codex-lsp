---
name: manage
description: 通过包内 CLI 与可审阅计划管理语言服务器及插件私有资产。
---

调用 lsp_manage 的 list、doctor 或 plan-install 获取状态与计划。
安装计划只展示，不自行执行命令。
向用户展示固定版本、校验来源、目标目录、网络访问和副作用，再通过 Codex 原生 Shell 审批执行包内 CLI。
不要把信任 Hook 当作安装或清理权限。

- 查看使用 `node <Plugin根>/dist/cli.js list`。
- 验证使用 `doctor --workspace <项目绝对路径>`，只有真实 initialize 成功才称 Ready。
- 安装使用 `plan <语言>` 与 `install <语言> --workspace <项目绝对路径>`。
- Rust 新安装使用官方固定版本资产及 SHA256 的 install-asset，不擅自修改 rustup 工具链。
- 配置使用 `configure <语言> --json <配置对象>`，变更后重启会话。
- 查实例使用 instances，重启必须同时提供 restart --instance 与 --workspace。
- 卸载使用 uninstall，活动租约会阻止删除。
- HTML 与 CSS 共享安装单元，删除一门语言保留另一门消费者。
- Plugin 移除默认保留配置和资产，显式 purge 只清理本包所有权记录内资产。
- 不删除用户已有工具、rustup 外部组件或其他 MCP 配置。

Plugin 更新用同一标识重新 add，保存旧包、配置与启禁状态，不能编造 plugin update 或 enable 子命令。
更新 Hook 后重新审阅，安装后启动新进程核对版本与构建哈希。
直接移除后需要恢复同版本包或使用同版本发行包内离线 CLI 执行清理。

指定Server使用 `restart clangd --instance <ID> --workspace <绝对路径>`，也可用c、ts、go等现有语言别名。
选择范围为该Core和工作区内同Server的全部项目根，不影响其他Server或Core。
省略Server明确表示全工作区重启。
只能给一个可选Server，未知目标或剩余参数必须报告失败，不以省略参数重试成全部重启。
协议1旧Core不支持指定Server时应提示新启动插件连接，不能将更新的CLI当作旧Core已升级。
