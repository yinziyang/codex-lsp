import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { McpHarness } from "./mcp-harness.ts";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 受控LS故意忽略EOF，验证宿主SIGKILL后仍有独立的有界退出路径。 */
test(
  "MCP被强杀时忽略EOF的受控LS仍在预算内退出",
  { timeout: 20000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "codex-lsp-kill-")),
    );
    const data = join(root, "data");
    await fs.mkdir(join(data, "config"), { recursive: true });
    await fs.writeFile(join(root, "main.ts"), "const value=1;");
    const log = join(root, "fake.jsonl");
    await fs.writeFile(
      join(data, "config/settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        authorizedWorkspaces: [root],
        servers: {
          typescript: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL("../test/fake-server.mjs", import.meta.url),
              ),
            ],
            env: { FAKE_LSP: JSON.stringify({ log, ignoreEof: true }) },
          },
        },
      }),
    );
    const child = spawn(
      process.execPath,
      ["plugins/codex-lsp/dist/cli.js", "serve", "--data-root", data],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const harness = new McpHarness(child);
    let lsPid: number | undefined;
    let guardPid: number | undefined;
    const request = (method: string, params: unknown) =>
      harness.request(method, params, AbortSignal.timeout(12000));
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "kill-test", version: "1" },
      });
      await request("tools/call", {
        name: "lsp",
        arguments: {
          workspaceRoot: root,
          filePath: "main.ts",
          line: 1,
          character: 7,
          operation: "hover",
        },
        _meta: { threadId: "kill-thread" },
      });
      const events = (await fs.readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      lsPid = events[0].pid;
      const leases = await fs.readdir(join(data, "runtime", "guards"));
      assert.equal(leases.length, 1);
      guardPid = JSON.parse(
        await fs.readFile(join(data, "runtime", "guards", leases[0]), "utf8"),
      ).guardPid;
      assert.ok(Number.isSafeInteger(lsPid) && lsPid! > 0);
      assert.ok(Number.isSafeInteger(guardPid) && guardPid! > 0);
      const exit = harness.exit;
      child.kill("SIGKILL");
      await exit;
      let alive = true;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        alive = [lsPid!, guardPid!].some((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        alive,
        false,
        "LS和私有守护必须都退出，不能只依靠LS配合EOF。",
      );
    } finally {
      child.kill("SIGKILL");
      await harness.close(AbortSignal.timeout(3000));
      if (lsPid) {
        try {
          process.kill(lsPid, "SIGKILL");
        } catch {}
      }
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
