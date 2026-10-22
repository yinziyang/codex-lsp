import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configuration,
  projectOverrides,
  workspaceAuthorized,
  setAuthorizationMode,
  authorize,
  selectPython,
} from "../src/configuration.ts";
import { atomicJson } from "../src/platform.ts";

test("新配置和旧配置默认自动授权，但不自动信任项目命令", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-lsp-authorization-"));
  const workspace = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-project-")),
  );
  const signal = AbortSignal.timeout(10000);
  try {
    assert.equal(
      (await configuration(root, signal)).workspaceAuthorization,
      "auto",
    );
    await atomicJson(
      join(root, "config/settings.json"),
      {
        schemaVersion: 1,
        authorizedWorkspaces: [],
        servers: {},
        future: true,
      },
      signal,
    );
    const old = await configuration(root, signal);
    assert.equal(old.workspaceAuthorization, "auto");
    assert.equal(old.future, true);
    await fs.writeFile(
      join(workspace, ".codex-lsp.json"),
      JSON.stringify({ servers: { gopls: { command: "untrusted-command" } } }),
    );
    const result = await projectOverrides(root, workspace, signal);
    assert.equal(result.servers.gopls, undefined);
    assert.ok(result.warnings.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("自动授权接受新项目，显式模式只放行登记项目且保留记录", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-mode-")),
  );
  const signal = AbortSignal.timeout(10000);
  try {
    assert.equal(
      workspaceAuthorized(await configuration(root, signal), root),
      true,
    );
    await setAuthorizationMode(root, "explicit", signal);
    assert.equal(
      workspaceAuthorized(await configuration(root, signal), root),
      false,
    );
    await authorize(root, root, signal);
    assert.equal(
      workspaceAuthorized(await configuration(root, signal), root),
      true,
    );
    assert.equal(
      workspaceAuthorized(
        await configuration(root, signal),
        join(root, "child"),
      ),
      false,
    );
    await setAuthorizationMode(root, "auto", signal);
    assert.equal(
      workspaceAuthorized(
        await configuration(root, signal),
        join(root, "child"),
      ),
      true,
    );
    await assert.rejects(
      setAuthorizationMode(root, "anything", signal),
      /InvalidInput/,
    );
    assert.deepEqual((await configuration(root, signal)).authorizedWorkspaces, [
      root,
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Python服务器切换原子关闭另一路由且保留参数", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-lsp-python-"));
  const signal = AbortSignal.timeout(10000);
  try {
    await atomicJson(
      join(root, "config/settings.json"),
      {
        schemaVersion: 1,
        authorizedWorkspaces: [],
        servers: { pyright: { enabled: true, args: ["--stdio"] } },
      },
      signal,
    );
    await selectPython(root, "basedpyright", signal);
    const config = await configuration(root, signal);
    assert.equal(config.servers.pyright.enabled, false);
    assert.equal(config.servers.basedpyright.enabled, true);
    assert.deepEqual(config.servers.pyright.args, ["--stdio"]);
    await selectPython(root, "pyright", signal);
    assert.equal(
      (await configuration(root, signal)).servers.basedpyright.enabled,
      false,
    );
    await assert.rejects(
      selectPython(root, "arbitrary-package", signal),
      /InvalidInput/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("非法授权模式拒绝加载，不静默变为自动授权", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-lsp-policy-"));
  try {
    await atomicJson(
      join(root, "config/settings.json"),
      {
        schemaVersion: 1,
        authorizedWorkspaces: [],
        servers: {},
        workspaceAuthorization: true,
      },
      AbortSignal.timeout(5000),
    );
    await assert.rejects(
      configuration(root, AbortSignal.timeout(5000)),
      /Broken/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
