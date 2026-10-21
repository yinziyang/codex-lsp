import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 使用真实发行物与真实 clangd，不能以模拟服务器替代此用例。 */
test(
  "真实 clangd 九操作、版本诊断与 EOF 退出",
  { timeout: 60000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "codex-lsp-real-")),
    );
    const workspace = join(root, "project");
    const data = join(root, "data");
    await fs.mkdir(workspace);
    await fs.mkdir(join(data, "config"), { recursive: true });
    await fs.writeFile(
      join(data, "config", "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        authorizedWorkspaces: [workspace],
        servers: {},
      }),
    );
    const file = join(workspace, "main.c");
    const text =
      "/*中文😀*/ int square(int n) { return n * n; }\r\nint main(void) { return square(3); }\r\n";
    await fs.writeFile(file, text);
    const child = spawn(
      process.execPath,
      ["plugins/codex-lsp/dist/cli.js", "serve", "--data-root", data],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_LSP_TRACE: "1" },
      },
    );
    let error = "";
    child.stderr.on("data", (v) => {
      error += v;
    });
    const pending = new Map<number, (x: any) => void>();
    let sequence = 0;
    const messages: any[] = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const x = JSON.parse(line);
      messages.push(x);
      pending.get(x.id)?.(x);
      pending.delete(x.id);
    });
    const call = async (method: string, params: unknown = {}) => {
      const id = ++sequence;
      const result = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("MCP request timeout " + error));
        }, 12000);
        pending.set(id, (x) => {
          clearTimeout(timer);
          resolve(x);
        });
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      return result;
    };
    const tool = async (name: string, args: unknown) => {
      const x = await call("tools/call", {
        name,
        arguments: args,
        _meta: { threadId: "real-thread" },
      });
      assert.ok(!x.result.isError, JSON.stringify(x));
      return JSON.parse(x.result.content[0].text);
    };
    try {
      await call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "product-test", version: "1" },
      });
      const results = [];
      let item: string | undefined;
      for (const operation of [
        "goToDefinition",
        "findReferences",
        "hover",
        "documentSymbol",
        "workspaceSymbol",
        "goToImplementation",
        "prepareCallHierarchy",
        "incomingCalls",
        "outgoingCalls",
      ]) {
        const result = await tool("lsp", {
          workspaceRoot: workspace,
          filePath: "main.c",
          operation,
          line: 1,
          character: text.indexOf("square") + 1,
          query: "square",
          ...(item && ["incomingCalls", "outgoingCalls"].includes(operation)
            ? { callHierarchyItemId: item }
            : {}),
        });
        assert.ok(
          ["Supported", "Empty", "Unsupported"].includes(result.status),
          JSON.stringify(result),
        );
        if (operation === "hover" || operation === "goToDefinition")
          assert.equal(result.status, "Supported");
        if (operation === "prepareCallHierarchy")
          item = result.callHierarchyItems?.[0]?.callHierarchyItemId;
        results.push({ operation, result });
      }
      const before = {
        sessionId: "real-session",
        turnId: "1",
        toolUseId: "t1",
        toolName: "Bash",
        toolInput: { command: "not parsed" },
        cwd: workspace,
      };
      await tool("diagnostics_before_tool", before);
      await fs.writeFile(file, "int main(void) { return missing_symbol; }\n");
      const result = await tool("diagnostics_after_tool", {
        ...before,
        toolResponse: { exit_code: 1 },
      });
      assert.match(
        result.hookSpecificOutput.additionalContext,
        /missing_symbol/,
      );
      assert.ok(
        Buffer.byteLength(result.hookSpecificOutput.additionalContext) <= 8000,
      );
      const repeat = await tool("diagnostics_after_tool", {
        ...before,
        toolResponse: { exit_code: 1 },
      });
      assert.deepEqual(repeat, result);
      const evidence = process.env.CODEX_LSP_EVIDENCE;
      if (evidence) {
        await fs.mkdir(evidence, { recursive: true });
        await fs.writeFile(
          join(evidence, "real-clangd-nine-operations.json"),
          JSON.stringify(results, null, 2),
        );
        await fs.writeFile(
          join(evidence, "real-product-diagnostics.json"),
          JSON.stringify(result, null, 2),
        );
        try {
          await fs.copyFile(
            join(data, "logs", "protocol.jsonl"),
            join(evidence, "real-product-protocol.jsonl"),
          );
        } catch {}
      }
    } finally {
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      const code = await exited;
      clearTimeout(timer);
      assert.equal(code, 0, error);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
