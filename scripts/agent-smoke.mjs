import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
const output = resolve(
  process.env.CODEX_LSP_EVIDENCE ?? ".artifacts/agent-smoke",
);
const workspace = join(output, "workspace");
const data = join(output, "data");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(join(data, "config"), { recursive: true });
await fs.writeFile(
  join(data, "config/settings.json"),
  JSON.stringify({
    schemaVersion: 1,
    authorizedWorkspaces: [workspace],
    servers: {},
  }),
);
const fixture =
  "int target(int n) { return n + 1; }\nint main(void) { return target(3); }\n";
const records = [];
async function run(name, enabled, prompt) {
  const start = performance.now();
  await fs.writeFile(join(workspace, "main.c"), fixture);
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    workspace,
    "-m",
    "gpt-6.1-sol",
    "-c",
    'model_reasoning_effort="medium"',
    "-c",
    `plugins.codex-lsp@codex-lsp-local.enabled=${enabled}`,
    prompt,
  ];
  const child = spawn("codex", args, {
    env: { ...process.env, CODEX_LSP_DATA_HOME: data, CODEX_LSP_TRACE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 90000);
  const hard = setTimeout(() => child.kill("SIGKILL"), 100000);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(deadline);
  clearTimeout(hard);
  await fs.writeFile(join(output, name + ".jsonl"), stdout);
  await fs.writeFile(join(output, name + ".stderr"), stderr);
  const events = stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const answer = events
    .filter((event) => event.item?.type === "agent_message")
    .map((event) => event.item.text)
    .join("\n");
  records.push({
    name,
    enabled,
    model: "gpt-6.1-sol",
    reasoning: "medium",
    code,
    elapsedMs: performance.now() - start,
    usage: events.find((event) => event.type === "turn.completed")?.usage,
    toolCalls: events.filter(
      (event) =>
        event.type === "item.completed" &&
        ["command_execution", "mcp_tool_call"].includes(event.item?.type),
    ).length,
    answer,
    modelCompleted: events.some((event) => event.type === "turn.completed"),
  });
}
const locate =
  "只读任务，不修改文件。定位 main.c 的 target 函数定义和 main 的调用位置，给出路径、准确行列及 target 返回类型。如果有LSP可用优先使用，Unsupported可文本回退。只输出结论。";
for (
  let round = 1;
  round <= (process.env.CODEX_LSP_SMOKE_MODE === "apply" ? 0 : 2);
  round++
)
  for (const enabled of [false, true])
    await run(`locate-${round}-${enabled ? "on" : "off"}`, enabled, locate);
await run(
  "apply-patch",
  true,
  `这是开发链路探针，只执行一次 apply_patch，绝对文件路径为 ${join(workspace, "main.c")}，完整旧行是 int main(void) { return target(3); }，替换成 int main(void) { return undeclared_apply_marker; }，随后不再执行任何工具，不主动调用任何MCP工具。最终回答逐字引用本轮自动收到的诊断；没有自动诊断就明确说没有。不要修复错误。`,
);
await fs.writeFile(
  join(output, "summary.json"),
  JSON.stringify(
    {
      environment: process.platform + "-" + process.arch,
      scope:
        "开发smoke，不是独立产品验收；定位小样本不能代表编程成功率或修复效果。",
      records,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    records.map(({ name, code, modelCompleted }) => ({
      name,
      code,
      modelCompleted,
    })),
  ),
);
