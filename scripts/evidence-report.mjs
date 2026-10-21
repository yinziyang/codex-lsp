import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
const evidence = resolve(
  process.env.CODEX_LSP_EVIDENCE ?? ".artifacts/real-matrix",
);
const matrix = JSON.parse(
  await fs.readFile(join(evidence, "real-server-matrix.json"), "utf8"),
);
let report =
  "# 兼容与效果报告。\n\n本报告只记录实际开发观测，不替代独立安装验收。\n三平台原生结果按GitHub Actions和独立记录另行追加，不将本机结果扩展到其他平台。\n\n## 语义矩阵。\n\n";
report +=
  "每格为实际服务器声明能力与请求结果的组合。\nSupported包含声明支持且返回空结果的情况，empty字段和原始结果保存在JSON矩阵，空结果不能单独证明准确性。\n原始initialize、JSON-RPC收发、语义及诊断保存在对应服务器protocol.jsonl。\n\n";
const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
];
report +=
  "| 服务器 | " +
  operations.join(" | ") +
  " |\n|---|" +
  operations.map(() => "---").join("|") +
  "|\n";
for (const row of matrix)
  report +=
    "| " +
    row.server +
    " | " +
    row.operations.map((value) => value.status).join(" | ") +
    " |\n";
report +=
  "\n本机平台为macOS arm64，Node24.18.1。\n本轮九操作矩阵记录了该轮build-info，后续修复需要重跑再记录新构建。\nTypeScript>=7的tsc LSP入口缺少本机可验证发行环境，保留NotTested和发布门槛。\n\n## 性能。\n\n";
const perf = JSON.parse(
  await fs.readFile(join(evidence, "performance-warm-hover.json"), "utf8"),
);
report += `真实MCP往返加预热clangd的20次hover样本P95为${perf.p95.toFixed(2)}毫秒。\n该数值包含文件内容校验、MCP和真实LS，不等于纯桥接额外耗时。\n未测纯桥接差分、definition和references的独立P95、扫描事件处理P95以及长期浸泡。\n不以单项hover满足建议目标推断全部性能达标。\n\n## AI效果。\n\n`;
const aiRoot = process.env.CODEX_LSP_AI_EVIDENCE;
if (aiRoot) {
  const ai = JSON.parse(
    await fs.readFile(join(aiRoot, "summary.json"), "utf8"),
  );
  report +=
    "| 样本 | 开关 | 输入Token | 工具次数 | 总耗时秒 | 完成 |\n|---|---|---|---|---|---|\n";
  for (const row of ai.records.filter((value) =>
    value.name.startsWith("locate"),
  ))
    report += `| ${row.name} | ${row.enabled} | ${row.usage?.input_tokens ?? "未取得"} | ${row.toolCalls} | ${(row.elapsedMs / 1000).toFixed(2)} | ${row.modelCompleted} |\n`;
}
report +=
  "\n模型固定gpt-6.1-sol，reasoning固定medium。\n每轮相同C夹具只读定位任务，定义为1:5、调用为2:25、返回类型int。\n该微型任务不测完整编程成功率、错误发现率或修复成功率，不能据此宣称通用收益。\n最初带引号的CLI dotted override未禁用插件，原off轨迹实际调用codex-lsp，该组作废。\n正确override必须先核plugin list中enabled=false，并确认关闭组没有本插件工具和Hook。\n失败的apply_patch没有写入错误，只能作为负例。\n开发自动诊断和独立B2产品验收分开记录。\n";
await fs.writeFile("docs/兼容与效果报告.md", report);
