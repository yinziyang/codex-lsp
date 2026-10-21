---
name: setup
description: 检查 Codex LSP 整包、Hook 信任、MCP 连接与工作区启动授权。
---

从当前技能文件路径定位 Plugin 根目录，包内 CLI 为根目录的 dist/cli.js。
先确认 Node >=22.18 与 Codex CLI 0.163.0。
本包使用官方 Legacy Plugin 包装以兼容固定客户端的 Hooks，不能改为全局独立 MCP 注册。

1. 在宿主 Plugin 管理中检查整个 codex-lsp@codex-lsp-local 已启用。
2. 引导用户在 `/hooks` 审阅五类 Hook，安装或启用本身不代表受信任。
3. 调用 lsp_manage 查看 MCP 连接及实例，遇到同名其他来源 MCP 时停止并报告冲突。
4. 展示 LS 可读写工作区、可能联网或执行构建脚本的权限边界。
5. 用户授权后通过 Codex 原生 Shell 审批执行 `node <Plugin根>/dist/cli.js authorize --workspace <项目绝对路径>`。
6. 执行包内 `doctor --workspace <项目绝对路径>`，缺少服务器时展示计划，不自动安装。
7. 在用户允许的夹具内执行错误编辑且不主动调用诊断工具，确认同轮模型实际读到诊断。
8. 分别报告 enabled、trusted、connected、feedback，任何未知项不能写完整启用成功。

Plugin 安装、更新、禁用和移除后，均在新启动进程核验生效。
SessionStart 早于 MCP 连接不证明自动反馈就绪。
空闲外部编辑只能等待下一次输入冲刷，内部合成代理不具有宿主用户 Hook 生命周期。
