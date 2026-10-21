import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Core } from "../src/core.ts";
import { LspClient } from "../extensions/pi-lsp/client.ts";
import { startControl, runtimes, control } from "../src/runtime.ts";
const fake = fileURLToPath(new URL("../test/fake-server.mjs", import.meta.url));
/** 多语言、多根和跨Core共同复现目标选择，使用真实子进程隔离协议时序。 */
test(
  "指定Server重启限定Core与工作区，别名覆盖同Server多根且缓存选择性失效",
  { timeout: 90000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "codex-lsp-restart-")),
    );
    const workspace = join(root, "project"),
      other = join(root, "other"),
      data = join(root, "data");
    await fs.mkdir(workspace);
    await fs.mkdir(other);
    await fs.writeFile(
      join(workspace, "main.c"),
      "int f(void) { return 1; }\n",
    );
    for (const name of ["a", "b"]) {
      await fs.mkdir(join(workspace, name));
      await fs.mkdir(join(workspace, name, ".git"));
      await fs.writeFile(join(workspace, name, "package.json"), "{}");
      await fs.writeFile(join(workspace, name, "main.ts"), "const value=1;\n");
    }
    const item = {
      name: "f",
      kind: 12,
      uri: pathToFileURL(join(workspace, "main.c")).href,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      selectionRange: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      data: { opaque: true },
    };
    const env = {
      FAKE_LSP: JSON.stringify({
        capabilities: { hoverProvider: true, callHierarchyProvider: true },
        responses: {
          "textDocument/hover": { contents: "x".repeat(40000) },
          "textDocument/prepareCallHierarchy": [item],
          "callHierarchy/incomingCalls": [],
        },
      }),
    };
    const make = () =>
      new Core({
        dataRoot: data,
        env: process.env,
        now: Date.now,
        identity: randomUUID,
        authorized: async () => true,
        serverOverrides: () =>
          Object.fromEntries(
            ["clangd", "typescript"].map((name) => [
              name,
              { command: process.execPath, args: [fake], env },
            ]),
          ),
        toolDirectories: () => [],
        createClient: (options) =>
          new LspClient({
            ...options,
            readiness: { minMs: 0, quietMs: 0, maxMs: 0 },
            startupTimeout: 3000,
            shutdownTimeout: 200,
          }),
      });
    const first = make(),
      second = make();
    let runtime: Awaited<ReturnType<typeof startControl>> | undefined;
    const query = (
      core: Core,
      filePath: string,
      operation = "hover",
      extra: Record<string, unknown> = {},
    ) =>
      core.query(
        "thread",
        {
          workspaceRoot: workspace,
          filePath,
          line: 1,
          character: 1,
          operation,
          ...extra,
        },
        AbortSignal.timeout(10000),
      ) as Promise<any>;
    const snapshot = (core: Core) =>
      core
        .status()
        .map(({ key, pid, generation }) => ({ key, pid, generation }));
    try {
      const details = new Map<string, string>(),
        items = new Map<string, string>();
      for (const core of [first, second])
        for (const file of ["main.c", "a/main.ts", "b/main.ts"]) {
          const hover = await query(core, file);
          const prepared = await query(core, file, "prepareCallHierarchy");
          if (core === first) {
            details.set(file, hover.responseId);
            items.set(file, prepared.callHierarchyItems[0].callHierarchyItemId);
          }
        }
      const before = snapshot(first),
        untouched = snapshot(second);
      const independentItem = (
        await query(second, "main.c", "prepareCallHierarchy")
      ).callHierarchyItems[0].callHierarchyItemId;
      assert.equal(before.length, 3);
      assert.equal(untouched.length, 3);
      await first.restart(workspace, AbortSignal.timeout(10000), "c");
      const after = snapshot(first);
      for (let index = 0; index < before.length; index++) {
        if (before[index].key.includes("clangd")) {
          assert.notEqual(after[index].pid, before[index].pid);
          assert.ok(after[index].generation > before[index].generation);
        } else assert.deepEqual(after[index], before[index]);
      }
      assert.deepEqual(snapshot(second), untouched);
      assert.notEqual(
        (
          await query(second, "main.c", "incomingCalls", {
            callHierarchyItemId: independentItem,
          })
        ).status,
        "StaleItem",
      );
      assert.equal(
        (
          await query(first, "main.c", "incomingCalls", {
            callHierarchyItemId: items.get("main.c"),
          })
        ).status,
        "StaleItem",
      );
      assert.throws(
        () => first.detail("thread", details.get("main.c")!, 0),
        /StaleItem/,
      );
      assert.notEqual(
        (
          await query(first, "a/main.ts", "incomingCalls", {
            callHierarchyItemId: items.get("a/main.ts"),
          })
        ).status,
        "StaleItem",
      );
      assert.ok(
        (first.detail("thread", details.get("a/main.ts")!, 0) as any).text
          .length > 0,
      );
      await first.restart(workspace, AbortSignal.timeout(10000), "ts");
      const multi = snapshot(first);
      for (let index = 0; index < after.length; index++) {
        if (after[index].key.includes("typescript")) {
          assert.notEqual(multi[index].pid, after[index].pid);
          assert.ok(multi[index].generation > after[index].generation);
        } else assert.deepEqual(multi[index], after[index]);
      }
      assert.deepEqual(snapshot(second), untouched);
      runtime = await startControl(data, first, [], AbortSignal.timeout(10000));
      const record = (await runtimes(data, AbortSignal.timeout(10000)))[0];
      await assert.rejects(
        control(
          { ...record, protocolVersion: 1 },
          "restart",
          workspace,
          AbortSignal.timeout(5000),
          "clangd",
        ),
        /Unsupported/,
      );
      for (const [workspaceTarget, server] of [
        [workspace, "unknown"],
        [workspace, "go"],
        [other, "clangd"],
      ])
        await assert.rejects(
          control(
            record,
            "restart",
            workspaceTarget,
            AbortSignal.timeout(5000),
            server,
          ),
        );
      await assert.rejects(
        control(
          { ...record, processIdentity: "wrong" },
          "restart",
          workspace,
          AbortSignal.timeout(5000),
          "clangd",
        ),
      );
      const response = await fetch(record.endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + record.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "invalid",
          protocolVersion: 2,
          instanceId: record.instanceId,
          action: "restart",
          workspace,
          server: "clangd",
          allServers: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(snapshot(first), multi);
      assert.deepEqual(snapshot(second), untouched);
      const cli = fileURLToPath(
        new URL("../plugins/codex-lsp/dist/cli.js", import.meta.url),
      );
      const base = [
        "--instance",
        record.instanceId,
        "--workspace",
        workspace,
        "--data-root",
        data,
      ];
      for (const args of [
        ["restart", "clangd", "typescript", ...base],
        ["restart", "clangd", ...base, "--instance", "duplicate"],
        ["restart", "unknown", ...base],
        ["restart", "--server", "clangd", ...base],
      ]) {
        await assert.rejects(
          promisify(execFile)(process.execPath, [cli, ...args], {
            signal: AbortSignal.timeout(10000),
          }),
          /InvalidInput/,
        );
        assert.deepEqual(snapshot(first), multi);
      }
      await promisify(execFile)(
        process.execPath,
        [cli, "restart", "clangd", ...base],
        { signal: AbortSignal.timeout(10000) },
      );
      const selected = snapshot(first);
      assert.deepEqual(
        selected.filter((value) => value.key.includes("typescript")),
        multi.filter((value) => value.key.includes("typescript")),
      );
      await first.restart(workspace, AbortSignal.timeout(10000));
      assert.ok(
        snapshot(first).every(
          (value, index) => value.generation > selected[index].generation,
        ),
      );
      assert.deepEqual(snapshot(second), untouched);
    } finally {
      await runtime?.close();
      await Promise.allSettled([first.close(), second.close()]);
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
