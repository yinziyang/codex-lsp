import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const output =
  process.env.CODEX_LSP_EVIDENCE ??
  join(repository, ".artifacts", "real-matrix");
await fs.mkdir(output, { recursive: true });
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
const cases = [
  ["gopls", "go", "main.go", "doubleValue", "Double"],
  ["rust-analyzer", "rust", "src/main.rs", "double_value", "double"],
  ["clangd", "c", "main.c", "double_value"],
  [
    "typescript-language-server",
    "typescript",
    "main.ts",
    "doubleValue",
    "double",
  ],
  ["pyright", "python", "main.py", "double_value"],
  ["html", "web", "main.html", "div"],
  ["css", "web", "main.css", "color"],
];
const matrix = [];
let tscVersion;
try {
  tscVersion = execFileSync("tsc", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
} catch {}
if (Number(tscVersion?.match(/Version (\d+)/)?.[1]) >= 7)
  cases.push(["tsc LSP", "typescript", "main.ts", "doubleValue", "double"]);
for (const [server, directory, file, symbol, implementation] of cases) {
  if (
    process.env.CODEX_LSP_MATRIX_SERVER &&
    server !== process.env.CODEX_LSP_MATRIX_SERVER
  )
    continue;
  const workspace = await fs.realpath(
    join(repository, "fixtures", "semantics", directory),
  );
  const data = join(repository, ".artifacts", "matrix-data", server);
  await fs.mkdir(join(data, "config"), { recursive: true });
  await fs.writeFile(
    join(data, "config", "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      authorizedWorkspaces: [workspace],
      servers:
        server === "tsc LSP"
          ? { typescript: { command: "tsc", args: ["--lsp", "--stdio"] } }
          : {},
    }),
  );
  const text = await fs.readFile(join(workspace, file), "utf8");
  const point = (name) => {
    const index = text.search(new RegExp("\\b" + name + "\\b"));
    const prefix = text.slice(0, index);
    return {
      line: prefix.split("\n").length,
      character: prefix.split("\n").at(-1).length + 1,
    };
  };
  await fs.rm(join(data, "logs/protocol.jsonl"), { force: true });
  const child = spawn(
    process.execPath,
    [
      join(repository, "plugins/codex-lsp/dist/cli.js"),
      "serve",
      "--data-root",
      data,
    ],
    {
      env: { ...process.env, CODEX_LSP_TRACE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let sequence = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  const request = (method, params) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          }) + "\n",
        );
        reject(new Error("请求超过45秒。"));
      }, 45000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  };
  const rows = [];
  let item;
  const deadline = setTimeout(() => child.kill("SIGTERM"), 180000);
  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "real-matrix", version: "1" },
    });
    for (const operation of operations) {
      const start = performance.now();
      let result;
      try {
        const response = await request("tools/call", {
          name: "lsp",
          arguments: {
            workspaceRoot: workspace,
            filePath: file,
            operation,
            ...point(
              operation === "goToImplementation" && implementation
                ? implementation
                : symbol,
            ),
            query: symbol,
            ...(item && ["incomingCalls", "outgoingCalls"].includes(operation)
              ? { callHierarchyItemId: item }
              : {}),
          },
          _meta: { threadId: "matrix-" + server },
        });
        result = response.result?.isError
          ? { status: "Failed", error: response.result }
          : JSON.parse(response.result.content[0].text);
        if (operation === "prepareCallHierarchy")
          item = result.callHierarchyItems?.[0]?.callHierarchyItemId;
      } catch (error) {
        result = { status: "Failed", error: String(error) };
      }
      rows.push({
        operation,
        status: ["Supported", "Empty"].includes(result.status)
          ? "Supported"
          : result.status === "Unsupported"
            ? "Unsupported"
            : "Failed",
        empty: result.status === "Empty",
        elapsedMs: performance.now() - start,
        result,
      });
    }
    const measurements = [];
    if (server === "clangd")
      for (let index = 0; index < 20; index++) {
        const start = performance.now();
        await request("tools/call", {
          name: "lsp",
          arguments: {
            workspaceRoot: workspace,
            filePath: file,
            operation: "hover",
            ...point(symbol),
          },
          _meta: { threadId: "matrix-" + server },
        });
        measurements.push(performance.now() - start);
      }
    if (measurements.length)
      await fs.writeFile(
        join(output, "performance-warm-hover.json"),
        JSON.stringify(
          {
            server,
            samples: measurements,
            p95: [...measurements].sort((a, b) => a - b)[
              Math.ceil(measurements.length * 0.95) - 1
            ],
            measurement:
              "真实MCP往返与已预热clangd总耗时，不等同于纯桥接开销。",
          },
          null,
          2,
        ) + "\n",
      );
  } finally {
    clearTimeout(deadline);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const hard = setTimeout(() => child.kill("SIGKILL"), 10000);
    const exitCode = await exited;
    clearTimeout(hard);
    let wire = "";
    try {
      wire = await fs.readFile(join(data, "logs", "protocol.jsonl"), "utf8");
      await fs.writeFile(join(output, server + "-protocol.jsonl"), wire);
    } catch {}
    const initialize = wire
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (value) =>
          value.method === "initialize" && value.direction === "receive",
      );
    matrix.push({
      server,
      ...(server === "tsc LSP"
        ? {
            executableVersion: tscVersion,
            command: "tsc",
            args: ["--lsp", "--stdio"],
          }
        : {}),
      platform: process.platform,
      node: process.version,
      build: JSON.parse(
        await fs.readFile(
          join(repository, "plugins/codex-lsp/dist/build-info.json"),
          "utf8",
        ),
      ),
      initialize: initialize?.result,
      exitCode,
      stderr,
      operations: rows,
    });
    await fs.writeFile(
      join(output, "real-server-matrix.json"),
      JSON.stringify(matrix, null, 2) + "\n",
    );
    console.log(
      server,
      rows.map((row) => row.status).join(","),
      "exit=" + exitCode,
    );
  }
}
if (!cases.some(([server]) => server === "tsc LSP"))
  matrix.push({
    server: "tsc LSP",
    platform: process.platform,
    status: "NotTested",
    reason:
      "本机未发现可验证的 TypeScript >=7 LSP 入口，不把 typescript-language-server 冒充该路径。",
    operations: operations.map((operation) => ({
      operation,
      status: "NotTested",
    })),
  });
await fs.writeFile(
  join(output, "real-server-matrix.json"),
  JSON.stringify(matrix, null, 2) + "\n",
);
