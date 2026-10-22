import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execute, atomicJson } from "../src/platform.ts";
import { McpHarness } from "./mcp-harness.ts";

const cli = resolve("plugins/codex-lsp/dist/cli.js");

test(
  "真实发行物在全新未授权项目启动clangd并忽略未信任项目命令",
  { timeout: 30000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "codex-lsp-auto-real-")),
    );
    const data = join(root, "data");
    const workspace = join(root, "project");
    await fs.mkdir(workspace);
    await fs.writeFile(
      join(workspace, "main.c"),
      "int square(int n) { return n * n; }\n",
    );
    await fs.writeFile(
      join(workspace, ".codex-lsp.json"),
      JSON.stringify({
        servers: { clangd: { command: "must-not-execute-untrusted-command" } },
      }),
    );
    const child = spawn(process.execPath, [cli, "serve", "--data-root", data], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const harness = new McpHarness(child);
    const signal = AbortSignal.timeout(20000);
    try {
      await harness.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "auto-authorization-test", version: "1" },
        },
        signal,
      );
      const result = await harness.request(
        "tools/call",
        {
          name: "lsp",
          arguments: {
            workspaceRoot: workspace,
            filePath: "main.c",
            operation: "documentSymbol",
            line: 1,
            character: 5,
          },
          _meta: { threadId: "new-project" },
        },
        signal,
      );
      assert.ok(!result.result.isError, JSON.stringify(result));
      const value = JSON.parse(result.result.content[0].text);
      assert.equal(value.status, "Supported", JSON.stringify(value));
      assert.match(JSON.stringify(value), /square/);
      const configPath = join(data, "config/settings.json");
      await assert.rejects(fs.access(configPath), { code: "ENOENT" });
    } finally {
      child.stdin.end();
      await Promise.race([
        harness.exit,
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("MCP退出超时。"));
          }, 6000);
          timer.unref();
          child.once("close", () => clearTimeout(timer));
        }),
      ]);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "短命令无需AI，状态表可用且升级后跟随宿主当前版本",
  { timeout: 30000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "codex-lsp-short-command-")),
    );
    const data = join(root, "data");
    const signal = AbortSignal.timeout(25000);
    const run = (args: string[]) =>
      execute(process.execPath, [cli, ...args, "--data-root", data], signal);
    try {
      const status = await run(["status"]);
      assert.match(status.stdout, /语言服务器/);
      assert.match(status.stdout, /自动，无需逐项目确认/);
      await assert.rejects(run(["install", "python"]), /非交互环境/);
      await run(["enable", "basedpyright"]);
      let settings = JSON.parse(
        await fs.readFile(join(data, "config/settings.json"), "utf8"),
      );
      assert.equal(settings.servers.basedpyright.enabled, true);
      assert.equal(settings.servers.pyright.enabled, false);
      await run(["disable", "basedpyright"]);
      settings = JSON.parse(
        await fs.readFile(join(data, "config/settings.json"), "utf8"),
      );
      assert.equal(settings.servers.basedpyright.enabled, false);
      if (process.platform === "win32") {
        await assert.rejects(
          run(["command-install", "--directory", join(root, "bin")]),
          /Unsupported/,
        );
        return;
      }
      const bin = join(root, "bin");
      const home = join(root, "codex-home");
      await run(["command-install", "--directory", bin]);
      const state = join(root, "plugin-list.json");
      const installed = (version: string) => ({
        installed: [
          { pluginId: "codex-lsp@codex-lsp-local", installed: true, version },
        ],
      });
      await fs.writeFile(
        join(bin, "codex"),
        `#!${process.execPath}\nconsole.log(require('fs').readFileSync(${JSON.stringify(state)},'utf8'));\n`,
        { mode: 0o700 },
      );
      const env = {
        ...process.env,
        CODEX_HOME: home,
        PATH:
          bin +
          ":" +
          dirname(process.execPath) +
          ":" +
          (process.env.PATH ?? ""),
      };
      const cache = join(
        home,
        "plugins/cache/codex-lsp-local/codex-lsp/0.2.1/dist",
      );
      await fs.mkdir(cache, { recursive: true });
      for (const file of ["cli.js", "guard.js", "build-info.json"])
        await fs.copyFile(join(dirname(cli), file), join(cache, file));
      await atomicJson(state, installed("0.2.1"), signal);
      const actual = await execute(
        join(bin, "codex-lsp"),
        ["status", "--data-root", data],
        signal,
        { env },
      );
      assert.match(actual.stdout, /语言服务器/);
      const updated = join(
        home,
        "plugins/cache/codex-lsp-local/codex-lsp/0.2.2/dist",
      );
      await fs.mkdir(updated, { recursive: true });
      const bytes = "console.log('current-installed-version-0.2.2');\n";
      await fs.writeFile(join(updated, "cli.js"), bytes);
      await atomicJson(
        join(updated, "build-info.json"),
        { buildHash: createHash("sha256").update(bytes).digest("hex") },
        signal,
      );
      await atomicJson(state, installed("0.2.2"), signal);
      const upgrade = await execute(
        join(bin, "codex-lsp"),
        ["version"],
        signal,
        { env },
      );
      assert.match(upgrade.stdout, /current-installed-version-0.2.2/);
      await fs.appendFile(join(updated, "cli.js"), "// changed\n");
      await assert.rejects(
        execute(join(bin, "codex-lsp"), ["version"], signal, { env }),
        /摘要不匹配/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
