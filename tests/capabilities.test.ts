import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Core } from "../src/core.ts";
import { LspClient } from "../extensions/pi-lsp/client.ts";
import { loadSettings } from "../extensions/pi-lsp/config.ts";
import { configuredServers } from "../src/server-configuration.ts";
import { installPlan } from "../src/assets.ts";
const fake = fileURLToPath(new URL("../test/fake-server.mjs", import.meta.url));
const signal = () => AbortSignal.timeout(15000);
function symbolCore(
  root: string,
  events: any[],
  script: Record<string, unknown> = {},
) {
  return new Core({
    dataRoot: join(root, "data"),
    env: process.env,
    now: Date.now,
    identity: randomUUID,
    authorized: async () => true,
    toolDirectories: () => [],
    serverOverrides: () => ({
      html: {
        command: process.execPath,
        args: [fake],
        env: {
          FAKE_LSP: JSON.stringify({
            capabilities: {
              documentSymbolProvider: true,
              ...((script.capabilities as object) ?? {}),
            },
            responses: {
              "textDocument/documentSymbol": [
                {
                  name: "Demo",
                  kind: 5,
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 8 },
                  },
                  selectionRange: {
                    start: { line: 0, character: 1 },
                    end: { line: 0, character: 5 },
                  },
                },
              ],
            },
            ...script,
          }),
        },
      },
    }),
    createClient: (options) =>
      new LspClient({
        ...options,
        readiness: { minMs: 0, quietMs: 0, maxMs: 0 },
      }),
    trace: (event) => events.push(event),
  });
}
test("Python显式选择basedpyright且保留pyright默认配置，冲突必须失败", () => {
  const original = loadSettings({
    agentDir: tmpdir(),
    cwd: tmpdir(),
    trusted: false,
  }).settings.servers;
  const defaults = configuredServers(original, {});
  assert.ok(defaults.find((x) => x.config.name === "pyright")?.enabled);
  assert.equal(
    defaults.find((x) => x.config.name === "basedpyright")?.enabled,
    false,
  );
  const selected = configuredServers(original, {
    basedpyright: { enabled: true },
  });
  assert.equal(
    selected.find((x) => x.config.name === "pyright")?.enabled,
    false,
  );
  assert.ok(selected.find((x) => x.config.name === "basedpyright")?.enabled);
  assert.throws(
    () =>
      configuredServers(original, {
        pyright: { enabled: true },
        basedpyright: { enabled: true },
      }),
    /冲突/,
  );
  assert.match(
    JSON.stringify(installPlan("basedpyright", tmpdir())),
    /basedpyright@1.40.2/,
  );
});
test("HTML工作区符号从真实文档协议聚合，跨文件筛选且不冒充原生能力", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-symbols-")),
  );
  await fs.mkdir(join(root, ".git"));
  const workspace = join(root, "project");
  await fs.mkdir(workspace);
  await fs.writeFile(join(workspace, "a.html"), "<section>one</section>");
  await fs.writeFile(join(workspace, "b.html"), "<section>two</section>");
  const events: any[] = [];
  const core = symbolCore(root, events);
  try {
    const query = (extra: Record<string, unknown> = {}) =>
      core.query(
        "thread",
        {
          operation: "workspaceSymbol",
          workspaceRoot: workspace,
          filePath: "a.html",
          line: 1,
          character: 1,
          query: "Demo",
          ...extra,
        },
        signal(),
      ) as Promise<any>;
    const result = await query();
    assert.equal(result.status, "Supported");
    assert.equal(result.source, "documentSymbol-aggregation");
    assert.equal(result.result.length, 2);
    assert.equal(
      new Set(result.result.map((x: any) => x.location.uri)).size,
      2,
    );
    assert.equal(
      core.status()[0].capabilities.workspaceSymbolProvider,
      undefined,
    );
    assert.equal((await query({ query: "absent" })).status, "Empty");
    await assert.rejects(query({ query: "🙂".repeat(10000) }), /query.*4096/);
    const limited = await query({ limit: 1 });
    assert.equal(limited.complete, false);
    assert.equal(limited.omitted, 1);
    await fs.writeFile(join(workspace, "ignored.html"), "<div>ignored</div>");
    await fs.writeFile(
      join(workspace, ".gitignore"),
      "ignored.html\nnested/*.html\n",
    );
    await fs.mkdir(join(workspace, "nested"));
    await fs.writeFile(join(workspace, "nested", ".gitignore"), "!keep.html\n");
    await fs.writeFile(
      join(workspace, "nested", "keep.html"),
      "<div>keep</div>",
    );
    await fs.writeFile(
      join(workspace, "nested", "excluded.html"),
      "<div>exclude</div>",
    );
    await fs.mkdir(join(workspace, "other-root", ".git"), { recursive: true });
    await fs.writeFile(
      join(workspace, "other-root", "hidden.html"),
      "<div>separate</div>",
    );
    await fs.mkdir(join(workspace, "node_modules"));
    await fs.writeFile(
      join(workspace, "node_modules", "hidden.html"),
      "<div>ignored directory</div>",
    );
    assert.equal((await query()).result.length, 3);
    await fs.writeFile(
      join(workspace, "a.html"),
      "<section>modified</section>",
    );
    await query();
    assert.ok(
      events.some(
        (x) =>
          x.event === "workspace-symbol-document" &&
          x.params.textDocument.uri.endsWith("/a.html") &&
          x.version === 2,
      ),
    );
    await query();
    assert.equal(
      events
        .filter(
          (x) =>
            x.event === "workspace-symbol-document" &&
            x.params.textDocument.uri.endsWith("/a.html"),
        )
        .at(-1).version,
      2,
    );
    await fs.unlink(join(workspace, "nested", "keep.html"));
    await fs.unlink(join(workspace, "b.html"));
    assert.equal((await query()).result.length, 1);
    assert.ok(events.some((x) => x.event === "workspace-symbol-document"));
    for (let index = 0; index < 140; index++)
      await fs.writeFile(
        join(workspace, "budget-" + index + ".html"),
        "<div>budget</div>",
      );
    const budgeted = await query({ limit: 1000 });
    assert.equal(budgeted.complete, false);
    assert.ok(budgeted.scannedFiles <= 128);
    assert.match(JSON.stringify(budgeted.warnings), /128/);
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("聚合文件打开前被替换成越界符号链接时拒绝读取", async () => {
  const { readSymbolFile } = await import("../src/workspace-symbols.ts");
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "symbol-race-")),
  );
  const project = join(root, "project");
  await fs.mkdir(project);
  const file = join(project, "a.html"),
    outside = join(root, "outside.html");
  await fs.writeFile(file, "inside");
  await fs.writeFile(outside, "OUTSIDE-MARKER");
  const open = fs.open;
  try {
    fs.open = async function (path, ...args) {
      if (path === file) {
        await fs.unlink(file);
        await fs.symlink(outside, file);
      }
      return open.call(fs, path, ...args);
    } as typeof fs.open;
    await assert.rejects(readSymbolFile(project, file, 1000, signal()));
  } finally {
    fs.open = open;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("聚合取消、畸形范围与大文件均不伪报完整结果", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "symbol-failure-")),
  );
  await fs.mkdir(join(root, "project"));
  const file = join(root, "project", "a.html");
  await fs.writeFile(file, "<div>test</div>");
  const query = (core: Core, cancellation = signal()) =>
    core.query(
      "thread",
      {
        operation: "workspaceSymbol",
        workspaceRoot: join(root, "project"),
        filePath: "a.html",
        line: 1,
        character: 1,
      },
      cancellation,
    ) as Promise<any>;
  const slow = symbolCore(root, [], {
    capabilities: { documentSymbolProvider: true },
    neverRespond: ["textDocument/documentSymbol"],
  });
  try {
    const cancelled = await query(slow, AbortSignal.timeout(200));
    assert.equal(cancelled.status, "Cancelled");
  } finally {
    await slow.close();
  }
  for (const item of [
    {
      name: "bad",
      kind: 99,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    },
    {
      name: "bad",
      kind: 5,
      range: {
        start: { line: 1, character: 3 },
        end: { line: 0, character: 1 },
      },
    },
    {
      name: "bad",
      kind: 5,
      location: {
        uri: "file:///outside.html",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
    },
  ]) {
    const core = symbolCore(root, [], {
      capabilities: { documentSymbolProvider: true },
      responses: { "textDocument/documentSymbol": [item] },
    });
    try {
      const result = await query(core);
      assert.equal(result.complete, false);
      assert.equal(result.result.length, 0);
      assert.match(JSON.stringify(result.warnings), /ProtocolError/);
    } finally {
      await core.close();
    }
  }
  const core = symbolCore(root, []);
  try {
    await fs.writeFile(join(root, "project", "huge.html"), "x".repeat(2000001));
    const partial = await query(core);
    assert.equal(partial.complete, false);
    assert.match(JSON.stringify(partial.warnings), /预算/);
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("扫描后换成FIFO或目录时打开有界且拒绝非普通文件", async () => {
  const { readSymbolFile } = await import("../src/workspace-symbols.ts");
  const { execFileSync } = await import("node:child_process");
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "symbol-special-")),
  );
  const file = join(root, "a.html");
  await fs.writeFile(file, "inside");
  const open = fs.open;
  try {
    fs.open = async function (path, ...args) {
      if (path === file) {
        await fs.unlink(file);
        if (process.platform === "win32") await fs.mkdir(file);
        else execFileSync("mkfifo", [file], { timeout: 2000 });
      }
      return open.call(fs, path, ...args);
    } as typeof fs.open;
    const start = Date.now();
    await assert.rejects(
      readSymbolFile(root, file, 1000, AbortSignal.timeout(500)),
    );
    assert.ok(Date.now() - start < 1000);
  } finally {
    fs.open = open;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("超大聚合输出仍带兼容来源与不完整标识，详情可读", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "symbol-output-")),
  );
  await fs.mkdir(join(root, "project"));
  await fs.writeFile(join(root, "project", "a.html"), "<div>test</div>");
  const responses = Array.from({ length: 300 }, (_, index) => ({
    name: "long-" + index + "x".repeat(200),
    kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  }));
  const core = symbolCore(root, [], {
    capabilities: { documentSymbolProvider: true },
    responses: { "textDocument/documentSymbol": responses },
  });
  try {
    const result = (await core.query(
      "thread",
      {
        operation: "workspaceSymbol",
        workspaceRoot: join(root, "project"),
        filePath: "a.html",
        line: 1,
        character: 1,
        limit: 1000,
      },
      signal(),
    )) as any;
    assert.equal(result.source, "documentSymbol-aggregation");
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.equal(typeof result.responseId, "string");
    let text = "",
      offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = core.detail("thread", result.responseId, offset) as any;
      text += page.text;
      offset = page.nextOffset;
    }
    const restored = JSON.parse(text);
    assert.equal(restored.source, "documentSymbol-aggregation");
    assert.equal(restored.result.length, 300);
  } finally {
    await core.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
