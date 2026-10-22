# 第三方声明。

pi-lsp 代码复用自 `https://github.com/yinziyang/pi-lsp` 的固定提交 `ff1004afc819c6f39d217949784c712c0e68ca0e`。
原始 MIT 许可及版权信息保留于 LICENSE。

- vscode-jsonrpc 与 vscode-languageserver-protocol 为 MIT 许可，版本由 package-lock.json 锁定。
- esbuild 为 MIT 许可，仅用于构建。
- smol-toml 为 MIT 许可，用于安装助手解析用户配置。
- TypeScript 与 Pi 依赖仅用于开发或 Pi 宿主集成，具体许可证见其包声明。
- 语言服务器不随本包重新分发，用户从官方来源下载，遵守各服务器许可证。

构建采用 legalComments:eof 保留 bundle 中第三方许可注释。
原始协议和用户源码不随发行包公开。

ignore 7.0.8为MIT许可，用于Web聚合的gitignore规则。
其原始版权与许可文本随Plugin保留于third-party/ignore-LICENSE，供应商法律文本保持原文。
