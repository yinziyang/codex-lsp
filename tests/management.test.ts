import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  statusTable,
  pythonServer,
  installedCommand,
} from "../src/management.ts";
import { installCommand } from "../src/command-install.ts";

test("状态表区分已安装但禁用和未安装，清除终端控制字符", () => {
  const text = statusTable(
    [
      {
        server: "basedpyright",
        enabled: false,
        status: "Installed",
        path: "/tmp/test\x1b[31m",
      },
      { server: "gopls", enabled: true, status: "Missing" },
    ],
    "auto",
  );
  assert.match(text, /basedpyright\s+否\s+已检测到/);
  assert.match(text, /gopls\s+是\s+未安装/);
  assert.match(text, /自动/);
  assert.ok(!text.includes("\x1b"));
});

test("Python选择和安装版本解析拒绝任意包、路径穿越及畸形宿主数据", () => {
  assert.equal(pythonServer("1"), "basedpyright");
  assert.equal(pythonServer(" pyright "), "pyright");
  for (const input of ["", "constructor", "__proto__", "some-package"])
    assert.throws(() => pythonServer(input), /InvalidInput/);
  const value = (version: string) => ({
    installed: [
      {
        pluginId: "codex-lsp@codex-lsp-local",
        installed: true,
        enabled: false,
        version,
      },
    ],
  });
  assert.equal(
    installedCommand(value("0.2.1"), "/home/test"),
    join(
      "/home/test",
      "plugins/cache/codex-lsp-local/codex-lsp/0.2.1/dist/cli.js",
    ),
  );
  assert.throws(
    () => installedCommand(value("../../elsewhere"), "/home"),
    /Broken/,
  );
  assert.throws(() => installedCommand(null, "/home"), /Broken/);
  assert.throws(() => installedCommand({ installed: [] }, "/home"), /Missing/);
});

test("命令安装固定Node并可更新自有文件，拒绝同名程序和符号链接", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-lsp-command-"));
  const signal = AbortSignal.timeout(10000);
  try {
    const source = join(root, "source.js");
    await fs.writeFile(source, "console.log('first');\n");
    const bin = join(root, "bin");
    const command = await installCommand(
      bin,
      source,
      "/test/node",
      "darwin",
      signal,
    );
    assert.ok(
      (await fs.readFile(command, "utf8")).startsWith("#!" + "/test/node"),
    );
    await fs.writeFile(source, "console.log('second');\n");
    await installCommand(bin, source, "/test/node", "darwin", signal);
    assert.match(await fs.readFile(command, "utf8"), /second/);
    await fs.writeFile(command, "user-command");
    await assert.rejects(
      installCommand(bin, source, "/test/node", "darwin", signal),
      /Conflict/,
    );
    await fs.rm(command);
    await fs.symlink(source, command);
    await assert.rejects(
      installCommand(bin, source, "/test/node", "darwin", signal),
      /Conflict/,
    );
    assert.match(await fs.readFile(source, "utf8"), /second/);
    await assert.rejects(
      installCommand(bin, source, "/test/node", "darwin", AbortSignal.abort()),
      /abort/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
