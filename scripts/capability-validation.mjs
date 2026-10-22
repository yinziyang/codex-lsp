import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { McpHarness } from "../tests/mcp-harness.ts";
const output = resolve(
  process.env.CODEX_LSP_EVIDENCE ?? ".artifacts/capabilities",
);
const cli = resolve(
  process.env.CODEX_LSP_PLUGIN_CLI ?? "plugins/codex-lsp/dist/cli.js",
);
const clangd = process.env.CODEX_LSP_LLVM_CLANGD;
if (!clangd || !isAbsolute(clangd))
  throw new Error(
    "须提供CODEX_LSP_LLVM_CLANGD已验证LLVM可执行文件绝对路径，不替换系统clangd。",
  );
const root = join(output, "workspace"),
  data = join(output, "data");
await fs.mkdir(root, { recursive: true });
await fs.mkdir(join(data, "config"), { recursive: true });
const texts = {
  "main.py":
    "class Base:\n    def work(self) -> int:\n        return 0\n\nclass Child(Base):\n    def work(self) -> int:\n        return 1\n",
  "main.c":
    "int c_callee(void) { return 1; }\nint c_caller(void) { return c_callee(); }\n",
  "main.cpp":
    "struct Base { virtual int work() { return 0; } };\nstruct Child : Base { int work() override { return 1; } };\nint cpp_callee() { return 1; }\nint cpp_caller() { return cpp_callee(); }\n",
  "a.html": '<section id="first"><div>one</div></section>',
  "b.html": '<article id="second">two</article>',
  "a.css": ".first { color: red; }",
  "b.css": ".second { color: blue; }",
};
for (const [name, text] of Object.entries(texts))
  await fs.writeFile(join(root, name), text);
await fs.writeFile(
  join(root, "compile_commands.json"),
  JSON.stringify(
    ["c", "cpp"].map((ext) => ({
      directory: root,
      file: join(root, "main." + ext),
      arguments: [
        ext === "c" ? "clang" : "clang++",
        ext === "c" ? "-std=c11" : "-std=c++17",
        "-c",
        join(root, "main." + ext),
      ],
    })),
  ),
);
await fs.writeFile(
  join(data, "config/settings.json"),
  JSON.stringify({
    schemaVersion: 1,
    authorizedWorkspaces: [root],
    servers: {
      basedpyright: { enabled: true },
      clangd: { command: clangd, args: ["--background-index"] },
    },
  }),
);
const run = (args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [cli, ...args, "--data-root", data, "--workspace", root],
      { encoding: "utf8", timeout: 600000 },
    ),
  );
const installed = run(["install", "basedpyright"]);
for (const name of ["pyright", "pyright-langserver"]) {
  for (const suffix of ["", ".cmd", ".ps1"])
    await assert.rejects(
      fs.stat(join(installed.asset.binDirectory, name + suffix)),
    );
}
const evidence = {
  installed,
  clangd: {
    command: clangd,
    args: ["--background-index"],
    version: execFileSync(clangd, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }),
    sha256: createHash("sha256")
      .update(await fs.readFile(clangd))
      .digest("hex"),
  },
  results: {},
  exits: [],
};
const child = spawn(process.execPath, [cli, "serve", "--data-root", data], {
  env: { ...process.env, CODEX_LSP_TRACE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
const h = new McpHarness(child);
const query = async (file, operation, extra = {}) => {
  const response = await h.request(
    "tools/call",
    {
      name: "lsp",
      arguments: {
        workspaceRoot: root,
        filePath: file,
        operation,
        line: 1,
        character: 1,
        ...extra,
      },
      _meta: { threadId: "capability-development" },
    },
    AbortSignal.timeout(45000),
  );
  assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
};
const position = (file, needle) => {
  const index = texts[file].indexOf(needle),
    prefix = texts[file].slice(0, index);
  return {
    line: prefix.split("\n").length,
    character: prefix.split("\n").at(-1).length + 1,
  };
};
try {
  await h.request(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "capability-development", version: "0.2.0" },
    },
    AbortSignal.timeout(10000),
  );
  const python = await query(
    "main.py",
    "goToImplementation",
    position("main.py", "work"),
  );
  assert.equal(python.status, "Supported");
  assert.ok(
    python.result.some(
      (item) =>
        item.uri === pathToFileURL(join(root, "main.py")).href &&
        item.range.start.line === 5 &&
        item.range.start.character === 8,
    ),
    "必须命中子类work实际位置，基类非空不足以通过。",
  );
  evidence.results.python = python;
  for (const file of ["main.c", "main.cpp"]) {
    const result = await query(
      file,
      "outgoingCalls",
      position(file, file.endsWith(".cpp") ? "cpp_caller" : "c_caller"),
    );
    assert.equal(result.status, "Supported");
    assert.ok(
      result.result.some(
        (item) =>
          item.to.name ===
            (file.endsWith(".cpp") ? "cpp_callee" : "c_callee") &&
          item.to.uri === pathToFileURL(join(root, file)).href &&
          item.to.selectionRange.start.line === (file.endsWith(".cpp") ? 2 : 0),
      ),
    );
    evidence.results[file] = result;
  }
  const cpp = await query(
    "main.cpp",
    "goToImplementation",
    position("main.cpp", "work"),
  );
  assert.equal(cpp.status, "Supported");
  assert.ok(
    cpp.result.some(
      (item) => (item.range ?? item.targetSelectionRange).start.line === 1,
    ),
  );
  evidence.results.cppImplementation = cpp;
  for (const ext of ["html", "css"]) {
    const first = await query("a." + ext, "workspaceSymbol", { query: "" });
    assert.equal(first.status, "Supported");
    assert.equal(first.source, "documentSymbol-aggregation");
    assert.equal(first.complete, true);
    assert.equal(
      new Set(first.result.map((item) => item.location.uri)).size,
      2,
    );
    assert.ok(first.result.some((item) => item.name.includes("first")));
    assert.ok(first.result.some((item) => item.name.includes("second")));
    const filtered = await query("a." + ext, "workspaceSymbol", {
      query: "second",
    });
    assert.equal(filtered.result.length, 1);
    assert.ok(filtered.result[0].location.uri.endsWith("/b." + ext));
    const unsupported = {};
    for (const operation of [
      "goToImplementation",
      "prepareCallHierarchy",
      "incomingCalls",
      "outgoingCalls",
    ]) {
      unsupported[operation] = await query("a." + ext, operation);
      assert.equal(unsupported[operation].status, "Unsupported");
    }
    await fs.writeFile(
      join(root, "b." + ext),
      ext === "html"
        ? '<article id="changed">new</article>'
        : ".changed { color: green; }",
    );
    const modified = await query("a." + ext, "workspaceSymbol", {
      query: "changed",
    });
    assert.equal(modified.status, "Supported");
    assert.equal(modified.result.length, 1);
    await fs.unlink(join(root, "b." + ext));
    const deleted = await query("a." + ext, "workspaceSymbol", {
      query: "second",
    });
    assert.equal(deleted.status, "Empty");
    evidence.results[ext] = { first, filtered, modified, deleted, unsupported };
  }
  evidence.status = run(["instances"]);
  for (const host of evidence.status.instances)
    for (const instance of host.instances.filter((i) =>
      ["html", "css"].includes(i.server),
    ))
      assert.ok(!instance.capabilities.workspaceSymbolProvider);
} catch (error) {
  await fs.writeFile(
    join(output, "failure.json"),
    JSON.stringify({ ...evidence, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  const leases = await fs.readdir(join(data, "runtime/guards"));
  const owned = [];
  for (const name of leases) {
    const lease = JSON.parse(
      await fs.readFile(join(data, "runtime/guards", name), "utf8"),
    );
    owned.push(lease.childPid, lease.guardPid);
  }
  const code = await h.close(AbortSignal.timeout(15000));
  assert.equal(code, 0);
  for (const pid of owned) {
    let gone = false;
    for (let count = 0; count < 50; count++) {
      try {
        process.kill(pid, 0);
      } catch {
        gone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(gone, "退出后LS或守护仍存活：" + pid);
  }
  evidence.exits.push({ pid: child.pid, code, ownedPidsGone: owned });
}
const trace = (await fs.readFile(join(data, "logs/protocol.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map(JSON.parse);
for (const [name, result] of Object.entries(evidence.results)) {
  if (["python", "main.c", "main.cpp", "cppImplementation"].includes(name)) {
    const operation =
      name === "python" || name === "cppImplementation"
        ? "goToImplementation"
        : "outgoingCalls";
    const wire = trace.find(
      (row) =>
        row.event === "semantic" &&
        row.operation === operation &&
        row.instance.includes(name === "python" ? "basedpyright" : "clangd") &&
        (operation === "goToImplementation" ||
          row.params.item.uri.endsWith("/" + name)) &&
        (name !== "cppImplementation" ||
          row.params.textDocument.uri.endsWith("/main.cpp")),
    );
    assert.ok(wire);
    assert.deepEqual(result.result, wire.result);
  } else {
    const raw = new Map();
    for (const row of trace.filter(
      (row) =>
        row.event === "workspace-symbol-document" &&
        row.params.textDocument.uri.endsWith("." + name),
    ))
      if (!raw.has(row.params.textDocument.uri))
        raw.set(row.params.textDocument.uri, row.result);
    const expected = [];
    const visit = (items, uri) => {
      for (const item of items) {
        expected.push({
          name: item.name,
          kind: item.kind,
          location: item.location ?? { uri, range: item.range },
          ...(typeof item.containerName === "string"
            ? { containerName: item.containerName }
            : {}),
        });
        if (item.children) visit(item.children, uri);
      }
    };
    for (const [uri, symbols] of raw) visit(symbols, uri);
    const sorted = (values) =>
      values.map((item) => JSON.stringify(item)).sort();
    assert.deepEqual(sorted(result.first.result), sorted(expected));
  }
}
await fs.writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      ...evidence,
      rawComparisons: "Python、C、C++及HTML/CSS逐文档原始响应比对通过",
      build: JSON.parse(
        await fs.readFile(join(resolve(cli, ".."), "build-info.json"), "utf8"),
      ),
    },
    null,
    2,
  ) + "\n",
);
await fs.copyFile(
  join(data, "logs/protocol.jsonl"),
  join(output, "protocol.jsonl"),
);
await fs.writeFile(
  join(output, "cleanup.json"),
  JSON.stringify(run(["uninstall", "basedpyright"]), null, 2) + "\n",
);
console.log(
  JSON.stringify({
    status: "passed",
    rawComparisons: true,
    processCleanup: true,
    privateAssetRemoved: true,
  }),
);
