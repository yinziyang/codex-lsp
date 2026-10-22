import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Core } from "../src/core.ts";
import { configuredServers } from "../src/server-configuration.ts";
import { loadSettings } from "../extensions/pi-lsp/config.ts";
import { WorkspaceIndex } from "../src/workspace.ts";
import { CodexAdapter } from "../src/mcp.ts";
import { waitUntil } from "../test/fixtures.ts";
import { WorkspaceWatch } from "../src/platform.ts";
import { LspClient } from "../extensions/pi-lsp/client.ts";

/** 用真实子进程隔离服务器时间与诊断返回，不依赖用户工具链。 */
function testCore(
  root: string,
  diagnostics = "pull",
  now: () => number = Date.now,
  script: Record<string, unknown> = {},
): Core {
  let identities = 0;
  return new Core({
    dataRoot: join(root, ".data"),
    env: process.env,
    now,
    identity: () => String(++identities),
    authorized: async () => true,
    toolDirectories: () => [],
    createClient: (options) =>
      new LspClient({
        ...options,
        readiness: { minMs: 0, quietMs: 0, maxMs: 0 },
      }),
    serverOverrides: () => ({
      typescript: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../test/fake-server.mjs", import.meta.url)),
        ],
        env: { FAKE_LSP: JSON.stringify({ diagnostics, ...script }) },
      },
    }),
  });
}

test(
  "自动诊断不扫描gitignore中的历史验收副本或耗尽实例额度",
  { timeout: 15000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "codex-lsp-hook-scope-")),
    );
    await fs.writeFile(join(root, "main.ts"), "const currentProject = 1;\n");
    await fs.writeFile(join(root, ".gitignore"), "outputs/\n");
    for (let n = 0; n < 26; n++) {
      const copy = join(root, "outputs", "round-" + n);
      await fs.mkdir(copy, { recursive: true });
      await fs.mkdir(join(copy, ".git"));
      await fs.writeFile(join(copy, "package.json"), "{}");
      await fs.writeFile(
        join(copy, "old.ts"),
        "const historicalFixture = 1;\n",
      );
    }
    const core = testCore(root);
    try {
      let result: { complete: boolean; warnings: string[] } | undefined;
      let failure: unknown;
      try {
        result = await core.reconcile(root, AbortSignal.timeout(10000));
      } catch (error) {
        failure = error;
      }
      assert.equal(
        core.status().length,
        1,
        "历史副本不应启动LS或占用24个实例额度。",
      );
      if (failure) throw failure;
      assert.equal(result?.complete, true, JSON.stringify(result));
      assert.equal(core.status()[0].root, root);
    } finally {
      await core.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("父容器不跨独立仓库或项目，实际项目保留monorepo子包", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-boundary-")),
  );
  let index: WorkspaceIndex | undefined;
  try {
    for (const name of ["repo", "package"]) {
      await fs.mkdir(join(root, name));
      if (name === "repo") await fs.mkdir(join(root, name, ".git"));
      else await fs.writeFile(join(root, name, "package.json"), "{}");
      await fs.writeFile(join(root, name, "main.ts"), "const independent = 1;");
    }
    index = new WorkspaceIndex(root);
    let result = await index.readBatch(AbortSignal.timeout(3000));
    assert.equal(result.files.size, 0);
    assert.equal(result.complete, true);
    index.close();
    await fs.mkdir(join(root, ".git"));
    index = new WorkspaceIndex(root);
    result = await index.readBatch(AbortSignal.timeout(3000));
    assert.deepEqual([...result.files.keys()], [join(root, "package/main.ts")]);
    assert.equal(result.complete, true);
  } finally {
    index?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("空闲回收真正释放实例额度，已停止实例不保留在状态列表", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-idle-")),
  );
  await fs.writeFile(join(root, "main.ts"), "const alive = 1;");
  let clock = 0;
  const core = testCore(root, "pull", () => clock);
  try {
    await core.reconcile(root, AbortSignal.timeout(3000));
    assert.equal(core.status().length, 1);
    clock = 600001;
    assert.ok(
      await waitUntil(() => core.status().length === 0, 2500),
      "空闲实例停止后必须从额度表删除。",
    );
    await core.query(
      "idle-query",
      {
        operation: "hover",
        workspaceRoot: root,
        filePath: "main.ts",
        line: 1,
        character: 7,
      },
      AbortSignal.timeout(3000),
    );
    assert.equal(core.status().length, 1);
    assert.equal(core.status()[0].state, "running");
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("无版本Push的Hook及时返回并保留诊断、未知状态和停止告警", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-push-hook-")),
  );
  await fs.writeFile(join(root, "main.ts"), "ERROR");
  const core = testCore(root, "push");
  const adapter = new CodexAdapter(core, join(root, ".data"));
  try {
    const result = await adapter.call(
      "diagnostics_before_stop",
      {
        cwd: root,
        sessionId: "test-session",
        turnId: "turn-1",
        stopHookActive: false,
      },
      { threadId: "test-thread" },
      AbortSignal.timeout(1500),
    );
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.decision, "block");
    assert.match(value.reason, /error on line/);
    assert.match(value.reason, /版本不确定/);
    assert.match(value.reason, /诊断仍待确认/);
    assert.doesNotMatch(value.reason, /诊断超时/);
    assert.equal(core.ledger.pending(root), true);
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("服务器冷启动期间文件已更新时，自动扫描不能同步旧快照", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-snapshot-")),
  );
  const file = join(root, "main.ts");
  const log = join(root, "protocol.jsonl");
  await fs.writeFile(file, "const oldSnapshot = 1;");
  const core = testCore(root, "pull", Date.now, { initDelayMs: 250, log });
  core.ledger.context("snapshot-thread", "snapshot-session");
  let pending: Promise<unknown> | undefined;
  try {
    pending = core.reconcile(root, AbortSignal.timeout(3000));
    pending.catch(() => {});
    assert.ok(
      await waitUntil(() => {
        try {
          return existsSync(log);
        } catch {
          return false;
        }
      }, 1000),
    );
    await fs.writeFile(file, "ERROR");
    await pending;
    const feedback = core.ledger.collect(
      "snapshot-thread",
      root,
      "after-startup",
    );
    assert.match(feedback, /error on line/);
  } finally {
    await pending?.catch(() => {});
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("回收后重新创建同一实例时，旧调用层级候选必须失效", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-retire-item-")),
  );
  const file = join(root, "main.ts");
  await fs.writeFile(file, "const target = 1;");
  let clock = 0;
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
  const core = testCore(root, "pull", () => clock, {
    capabilities: { callHierarchyProvider: true },
    responses: {
      "textDocument/prepareCallHierarchy": [
        {
          name: "target",
          kind: 12,
          uri: pathToFileURL(file).href,
          range,
          selectionRange: range,
        },
      ],
      "callHierarchy/incomingCalls": [],
    },
  });
  const query = (operation: string, extra: Record<string, unknown> = {}) =>
    core.query(
      "retire-thread",
      {
        operation,
        workspaceRoot: root,
        filePath: "main.ts",
        line: 1,
        character: 7,
        ...extra,
      },
      AbortSignal.timeout(3000),
    ) as Promise<{
      status: string;
      callHierarchyItems?: { callHierarchyItemId: string }[];
    }>;
  try {
    const prepared = await query("prepareCallHierarchy");
    const id = prepared.callHierarchyItems?.[0]?.callHierarchyItemId;
    assert.ok(id);
    await core.reconcile(root, AbortSignal.timeout(3000));
    clock = 600001;
    assert.ok(await waitUntil(() => core.status().length === 0, 2500));
    assert.equal(
      (await query("incomingCalls", { callHierarchyItemId: id })).status,
      "StaleItem",
    );
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("默认clangd保留后台索引并限制两个工作线程，用户参数和自定义命令不被改写", () => {
  const servers = loadSettings({
    agentDir: tmpdir(),
    cwd: tmpdir(),
    trusted: false,
  }).settings.servers;
  const select = (overrides: Record<string, Record<string, unknown>>) =>
    configuredServers(servers, overrides).find(
      (value) => value.config.name === "clangd",
    )!.config;
  assert.deepEqual(select({}).args, ["--background-index", "-j=2"]);
  assert.deepEqual(
    select({ clangd: { args: ["--background-index", "-j=6"] } }).args,
    ["--background-index", "-j=6"],
  );
  assert.deepEqual(select({ clangd: { command: "my-clangd" } }).args, [
    "--background-index",
  ]);
});

test("容器目录不递归读取无项目标记的历史脚本", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-container-")),
  );
  await fs.mkdir(join(root, "outputs"));
  await fs.writeFile(
    join(root, "outputs/probe.mjs"),
    "throw new Error('historical');",
  );
  const index = new WorkspaceIndex(root);
  try {
    const result = await index.readBatch(AbortSignal.timeout(500));
    assert.equal(result.complete, true);
    assert.equal(result.files.size, 0);
    assert.match(result.warnings.join(" "), /实际项目目录/);
  } finally {
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("监听关闭后切换递归模式不得重新打开监听", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-watch-close-")),
  );
  const watch = new WorkspaceWatch(root, false);
  try {
    assert.equal(watch.error, undefined);
    watch.close();
    watch.dirty = false;
    watch.setRecursive(true);
    await fs.writeFile(join(root, "new.ts"), "const value = 1;");
    assert.equal(await waitUntil(() => watch.dirty, 100), false);
  } finally {
    watch.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("文件被gitignore排除时明确移出范围，不伪报删除或修复，再纳入时恢复诊断", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-exclude-")),
  );
  await fs.writeFile(join(root, "main.ts"), "ERROR");
  const core = testCore(root);
  core.ledger.context("exclude-thread", "exclude-session");
  try {
    await core.reconcile(root, AbortSignal.timeout(3000));
    assert.match(
      core.ledger.collect("exclude-thread", root, "before"),
      /error on line/,
    );
    await fs.writeFile(join(root, ".gitignore"), "*.ts");
    await core.reconcile(root, AbortSignal.timeout(3000));
    const excluded = core.ledger.collect("exclude-thread", root, "excluded");
    assert.match(excluded, /移出自动诊断范围/);
    assert.doesNotMatch(excluded, /文件已删除|resolved-diagnostics/);
    await fs.writeFile(join(root, ".gitignore"), "");
    await core.reconcile(root, AbortSignal.timeout(3000));
    assert.match(
      core.ledger.collect("exclude-thread", root, "restored"),
      /error on line/,
    );
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("诊断尚未返回时不因100ms短窗口提前丢失同轮错误", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-late-push-")),
  );
  await fs.writeFile(join(root, "main.ts"), "ERROR");
  const core = testCore(root, "push", Date.now, {
    publishDelayMs: 250,
    publishVersion: 1,
  });
  const adapter = new CodexAdapter(core, join(root, ".data"));
  try {
    const result = await adapter.call(
      "diagnostics_before_stop",
      {
        cwd: root,
        sessionId: "late-session",
        turnId: "late-turn",
        stopHookActive: false,
      },
      { threadId: "late-thread" },
      AbortSignal.timeout(1500),
    );
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.decision, "block");
    assert.match(value.reason, /error on line/);
    assert.doesNotMatch(value.reason, /diagnostics-unknown|诊断超时/);
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
