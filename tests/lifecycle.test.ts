import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LspClient } from "../extensions/pi-lsp/client.ts";
import { CodexAdapter } from "../src/mcp.ts";
import { Core } from "../src/core.ts";
const fake = fileURLToPath(new URL("../test/fake-server.mjs", import.meta.url));
test("ContentModified退避中取消必须及时结束", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-lsp-cancel-"));
  const client = new LspClient({
    name: "test",
    command: process.execPath,
    args: [fake],
    root,
    env: {
      ...process.env,
      FAKE_LSP: JSON.stringify({
        contentModified: { "textDocument/hover": 10 },
      }),
    },
    initializationOptions: {},
    settings: {},
    startupTimeout: 3000,
    requestTimeout: 3000,
    shutdownTimeout: 200,
    pullDiagnostics: false,
    onDiagnostics: () => {},
    onDiagnosticsRefresh: () => {},
    onCrash: () => {},
  });
  try {
    await client.start();
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      client.request("textDocument/hover", {}, controller.signal),
    );
    assert.ok(Date.now() - start < 250, "取消不应等待500ms退避完成。");
  } finally {
    await client.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("每项MCP工具schema的properties必须是对象且必需字段真实存在", () => {
  const core = new Core({
    dataRoot: tmpdir(),
    env: process.env,
    now: () => Date.now(),
    identity: () => "",
    createClient: (options) => new LspClient(options),
    authorized: async () => false,
    serverOverrides: () => ({}),
    toolDirectories: () => [],
  });
  try {
    const adapter = new CodexAdapter(core, tmpdir());
    for (const tool of adapter.tools() as any[]) {
      assert.equal(typeof tool.inputSchema.properties, "object");
      assert.equal(
        Array.isArray(tool.inputSchema.properties),
        false,
        tool.name,
      );
      for (const required of tool.inputSchema.required)
        assert.ok(
          required in tool.inputSchema.properties,
          tool.name + " " + required,
        );
    }
  } finally {
    void core.close();
  }
});

test("同方法多项动态注册按id注销，剩余过滤器不能丢失", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-lsp-register-"));
  const client = new LspClient({
    name: "registration",
    command: process.execPath,
    args: [fake],
    root,
    env: {
      ...process.env,
      FAKE_LSP: JSON.stringify({
        serverRequests: [
          {
            method: "client/registerCapability",
            params: {
              registrations: [
                {
                  id: "one",
                  method: "workspace/didChangeWatchedFiles",
                  registerOptions: { watchers: [{ globPattern: "**/*.go" }] },
                },
                {
                  id: "two",
                  method: "workspace/didChangeWatchedFiles",
                  registerOptions: { watchers: [{ globPattern: "**/*.ts" }] },
                },
              ],
            },
          },
          {
            method: "client/unregisterCapability",
            params: {
              unregisterations: [
                { id: "two", method: "workspace/didChangeWatchedFiles" },
              ],
            },
          },
        ],
      }),
    },
    initializationOptions: {},
    settings: {},
    startupTimeout: 3000,
    requestTimeout: 1000,
    shutdownTimeout: 200,
    pullDiagnostics: false,
    onDiagnostics: () => {},
    onDiagnosticsRefresh: () => {},
    onCrash: () => {},
  });
  try {
    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      client.registrations.has("workspace/didChangeWatchedFiles"),
      true,
    );
    assert.deepEqual(
      client.registrationOptions.get("workspace/didChangeWatchedFiles"),
      { watchers: [{ globPattern: "**/*.go" }] },
    );
  } finally {
    await client.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("原生PowerShell环境清除父宿主模块路径但保留其他变量", async () => {
  const { nativePowerShellEnvironment } = await import(
    "../extensions/pi-lsp/process.ts"
  );
  const original = {
    PSModulePath: "PowerShell7-only",
    psModulePath: "incompatible",
    PATH: "tools",
    MARKER: "keep",
  };
  assert.deepEqual(nativePowerShellEnvironment(original), {
    PATH: "tools",
    MARKER: "keep",
  });
  assert.equal(original.PSModulePath, "PowerShell7-only");
});
