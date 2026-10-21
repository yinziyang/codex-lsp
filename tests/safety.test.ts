import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticLedger } from "../src/diagnostics.ts";
import { workspacePath, atomicJson } from "../src/platform.ts";
import { WorkspaceIndex } from "../src/workspace.ts";
import { configuration, configure } from "../src/configuration.ts";
import { uninstall, assets, installPlan } from "../src/assets.ts";
const signal = () => AbortSignal.timeout(10000);
const temporary = async () =>
  fs.realpath(await fs.mkdtemp(join(tmpdir(), "codex-lsp-safety-")));
test("工作区越界、符号链接、取消与畸形配置均拒绝", async () => {
  const root = await temporary();
  try {
    await fs.writeFile(join(root, "a.ts"), "x");
    await fs.symlink(join(root, "a.ts"), join(root, "link.ts"));
    await assert.rejects(
      workspacePath(root, "../outside", signal()),
      /PermissionDenied/,
    );
    await assert.rejects(
      workspacePath(root, "link.ts", signal()),
      /PermissionDenied/,
    );
    await assert.rejects(
      workspacePath(root, "a.ts", AbortSignal.abort()),
      /abort/i,
    );
    await fs.mkdir(join(root, "config"));
    await fs.writeFile(join(root, "config/settings.json"), "null");
    await assert.rejects(configuration(root, signal()), /Broken/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("未知配置字段保留，非法配置失败回滚", async () => {
  const root = await temporary();
  try {
    const path = join(root, "config/settings.json");
    const original = {
      schemaVersion: 1,
      authorizedWorkspaces: [],
      servers: {},
      future: { preserved: true },
    };
    await atomicJson(path, original, signal());
    await configure(root, "go", { enabled: false }, signal());
    assert.deepEqual(
      (await configuration(root, signal())).future,
      original.future,
    );
    await assert.rejects(
      configure(root, "go", { args: 123 }, signal()),
      /Broken/,
    );
    assert.equal(
      (await configuration(root, signal())).servers.gopls.enabled,
      false,
    );
    assert.equal(
      (await configuration(root, signal())).servers.gopls.args,
      undefined,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("共享HTML/CSS只移除消费者，不删除其他用户工具", async () => {
  const root = await temporary();
  try {
    const path = join(root, "assets/web-owned");
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, "content"), "owned");
    await atomicJson(
      join(root, "ownership/web.json"),
      {
        schemaVersion: 1,
        creator: "codex-lsp",
        transaction: "test",
        unit: "web",
        path,
        version: "fixed",
        checksum: "test",
        consumers: ["html", "css"],
        binDirectory: path,
        source: "test",
      },
      signal(),
    );
    await uninstall(root, "html", signal());
    assert.equal(await fs.readFile(join(path, "content"), "utf8"), "owned");
    assert.deepEqual((await assets(root, signal()))[0].consumers, ["css"]);
    await uninstall(root, "css", signal());
    await assert.rejects(fs.stat(path));
    await assert.rejects(uninstall(root, "clangd", signal()), /NotOwned/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("安装计划纯只读、固定版本、无latest和rustup隐式修改", async () => {
  const root = await temporary();
  try {
    for (const language of [
      "go",
      "rust",
      "clangd",
      "typescript",
      "python",
      "html",
      "css",
    ]) {
      const plan = installPlan(language, root);
      assert.ok(!JSON.stringify(plan).includes("@latest"));
    }
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("扫描分批覆盖全部文件，内容摘要发现同mtime同size修改", async () => {
  const root = await temporary();
  let index: WorkspaceIndex | undefined;
  try {
    for (let i = 0; i < 25; i++)
      await fs.writeFile(join(root, `a${i}.ts`), "const a=1;");
    index = new WorkspaceIndex(root);
    let result = await index.readBatch(signal(), 3);
    assert.equal(result.complete, false);
    let rounds = 0;
    while (!result.complete) {
      result = await index.readBatch(signal(), 3);
      assert.ok(++rounds < 20);
    }
    assert.equal(result.files.size, 25);
    const file = join(root, "a0.ts");
    const before = result.files.get(file)!.hash;
    const stat = await fs.stat(file);
    await fs.writeFile(file, "const a=2;");
    await fs.utimes(file, stat.atime, stat.mtime);
    result = await index.readBatch(signal(), 100);
    assert.notEqual(result.files.get(file)!.hash, before);
  } finally {
    index?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("相同URI不同工作区基线隔离", () => {
  const ledger = new DiagnosticLedger();
  const diagnostic = {
    message: "A",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  };
  ledger.context("thread", "session");
  ledger.edit("/parent", "file:///parent/child/a.ts", 1, 1, ["push"]);
  ledger.receive(
    "file:///parent/child/a.ts",
    "push",
    [diagnostic],
    1,
    1,
    undefined,
    false,
    "/parent",
  );
  ledger.edit("/parent/child", "file:///parent/child/a.ts", 1, 1, ["push"]);
  ledger.receive(
    "file:///parent/child/a.ts",
    "push",
    [diagnostic],
    1,
    1,
    undefined,
    false,
    "/parent/child",
  );
  assert.match(ledger.collect("thread", "/parent", "a"), /current-diagnostics/);
  assert.match(
    ledger.collect("thread", "/parent/child", "b"),
    /current-diagnostics/,
  );
});
