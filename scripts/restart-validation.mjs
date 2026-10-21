import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { McpHarness } from "../tests/mcp-harness.ts";
const output = resolve(
    process.env.CODEX_LSP_EVIDENCE ?? ".artifacts/restart-validation",
  ),
  workspace = join(output, "workspace"),
  data = join(output, "data");
const cli = resolve("plugins/codex-lsp/dist/cli.js"),
  hosts = [],
  evidence = {};
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(join(output, "other"), { recursive: true });
await fs.mkdir(join(data, "config"), { recursive: true });
await fs.writeFile(join(workspace, "main.c"), "int f(void) { return 1; }\n");
for (const name of ["a", "b"]) {
  await fs.mkdir(join(workspace, name, ".git"), { recursive: true });
  await fs.writeFile(join(workspace, name, "main.ts"), "const value=1;\n");
}
await fs.writeFile(
  join(data, "config/settings.json"),
  JSON.stringify({
    schemaVersion: 1,
    authorizedWorkspaces: [workspace],
    servers: {},
  }),
);
const command = (args) =>
  JSON.parse(
    execFileSync(process.execPath, [cli, ...args, "--data-root", data], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
const list = () => command(["instances"]).instances;
const state = (host) =>
  host.instances.map(({ key, pid, generation }) => ({ key, pid, generation }));
try {
  for (let index = 0; index < 2; index++) {
    const child = spawn(process.execPath, [cli, "serve", "--data-root", data], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const h = new McpHarness(child);
    hosts.push({ h, pid: child.pid });
    await h.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "restart-validation", version: "0.1.4" },
      },
      AbortSignal.timeout(10000),
    );
    for (const file of ["main.c", "a/main.ts", "b/main.ts"]) {
      const value = await h.request(
        "tools/call",
        {
          name: "lsp",
          arguments: {
            operation: "hover",
            workspaceRoot: workspace,
            filePath: file,
            line: 1,
            character: file.endsWith(".c") ? 5 : 7,
          },
          _meta: { threadId: "restart-" + index },
        },
        AbortSignal.timeout(45000),
      );
      assert.equal(value.result.isError, undefined);
      assert.ok(
        ["Supported", "Empty"].includes(
          JSON.parse(value.result.content[0].text).status,
        ),
      );
    }
  }
  evidence.before = list();
  const target = evidence.before.find((host) => host.pid === hosts[0].pid),
    other = evidence.before.find((host) => host.pid === hosts[1].pid);
  assert.equal(target.instances.length, 3);
  assert.equal(other.instances.length, 3);
  const base = ["--instance", target.instanceId, "--workspace", workspace];
  evidence.selectedRequest = ["restart", "clangd", ...base];
  evidence.selected = command(evidence.selectedRequest);
  evidence.afterClangd = list();
  const changed = evidence.afterClangd.find(
    (host) => host.pid === hosts[0].pid,
  );
  assert.deepEqual(
    state(evidence.afterClangd.find((host) => host.pid === hosts[1].pid)),
    state(other),
  );
  assert.deepEqual(
    state(changed).filter((value) => value.key.includes("typescript")),
    state(target).filter((value) => value.key.includes("typescript")),
  );
  assert.notEqual(
    changed.instances.find((value) => value.server === "clangd").pid,
    target.instances.find((value) => value.server === "clangd").pid,
  );
  evidence.invalid = [];
  for (const args of [
    ["restart", "invalid", ...base],
    ["restart", "go", ...base],
    ["restart", "clangd", "typescript", ...base],
    ["restart", "clangd", ...base, "--instance", "duplicate"],
    [
      "restart",
      "clangd",
      "--instance",
      target.instanceId,
      "--workspace",
      join(output, "other"),
    ],
    ["restart", "clangd", "--instance", "wrong", "--workspace", workspace],
    ["restart", "--server", "clangd", ...base],
  ]) {
    let failure;
    try {
      command(args);
    } catch (error) {
      failure = { code: error.status, message: String(error.stderr) };
    }
    assert.ok(failure?.code);
    evidence.invalid.push({ args, ...failure });
    assert.deepEqual(list().map(state), evidence.afterClangd.map(state));
  }
  evidence.multiroot = command(["restart", "ts", ...base]);
  evidence.afterTypescript = list();
  const roots = evidence.afterTypescript.find(
    (host) => host.pid === hosts[0].pid,
  );
  assert.deepEqual(
    state(roots).filter((value) => value.key.includes("clangd")),
    state(changed).filter((value) => value.key.includes("clangd")),
  );
  for (const instance of roots.instances.filter(
    (value) => value.server === "typescript",
  ))
    assert.ok(
      instance.generation >
        changed.instances.find((value) => value.key === instance.key)
          .generation,
    );
  assert.deepEqual(
    state(evidence.afterTypescript.find((host) => host.pid === hosts[1].pid)),
    state(other),
  );
  evidence.all = command(["restart", ...base]);
  evidence.afterAll = list();
  assert.ok(
    evidence.afterAll
      .find((host) => host.pid === hosts[0].pid)
      .instances.every(
        (value) =>
          value.generation >
          roots.instances.find((old) => old.key === value.key).generation,
      ),
  );
  evidence.status = "passed";
} finally {
  evidence.exits = [];
  for (const { h, pid } of hosts) {
    const start = Date.now();
    const code = await h.close(AbortSignal.timeout(10000));
    evidence.exits.push({ pid, code, elapsedMs: Date.now() - start });
    assert.equal(code, 0);
  }
  await fs.writeFile(
    join(output, "control-validation.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    status: evidence.status,
    cores: hosts.length,
    instancesPerCore: 3,
    invalidTargets: evidence.invalid.length,
  }),
);
