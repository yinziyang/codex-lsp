import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Core } from "../src/core.ts";
import { LspClient } from "../extensions/pi-lsp/client.ts";
import { CodexAdapter } from "../src/mcp.ts";
import { waitUntil } from "../test/fixtures.ts";
import { startControl, runtimes, control } from "../src/runtime.ts";
import {
  configuration,
  projectOverrides,
  trustProject,
  configure,
} from "../src/configuration.ts";
const fake = fileURLToPath(new URL("../test/fake-server.mjs", import.meta.url));
/** 仅受控协议测试使用假 LS，日志保留请求以验证不透明 data。 */
async function setup(
  script:
    | Record<string, unknown>
    | ((root: string) => Record<string, unknown>) = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-core-")),
  );
  await fs.writeFile(join(root, "main.ts"), "const example = 1;\n");
  const log = join(root, "wire.jsonl");
  const actual = typeof script === "function" ? script(root) : script;
  const scriptFile = join(root, "fake-script.json");
  await fs.writeFile(scriptFile, JSON.stringify({ log, ...actual }));
  let count = 0;
  const events: any[] = [];
  const clients: LspClient[] = [];
  const core = new Core({
    dataRoot: join(root, "data"),
    env: process.env,
    now: () => Date.now(),
    identity: () => `item-${++count}`,
    createClient: (options) => {
      const client = new LspClient({
        ...options,
        readiness: { minMs: 0, quietMs: 0, maxMs: 0 },
      });
      clients.push(client);
      return client;
    },
    authorized: async () => true,
    serverOverrides: () => ({
      typescript: {
        command: process.execPath,
        args: [fake],
        env: { FAKE_LSP_FILE: scriptFile },
      },
    }),
    toolDirectories: () => [],
    trace: (event) => events.push(event),
  });
  const query = (
    operation: string,
    extra: Record<string, unknown> = {},
    thread = "t",
  ) =>
    core.query(
      thread,
      {
        workspaceRoot: root,
        filePath: "main.ts",
        line: 1,
        character: 7,
        operation,
        ...extra,
      },
      AbortSignal.timeout(10000),
    );
  return {
    root,
    log,
    core,
    query,
    events,
    clients,
    close: async () => {
      await core.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
test("能力缺失与MethodNotFound分别返回Unsupported，空结果保持Empty", async () => {
  const s = await setup({
    errors: { "textDocument/hover": { code: -32601, message: "absent" } },
  });
  try {
    assert.equal(
      ((await s.query("goToImplementation")) as any).status,
      "Unsupported",
    );
    assert.equal(((await s.query("hover")) as any).status, "Unsupported");
    assert.equal(((await s.query("goToDefinition")) as any).status, "Empty");
  } finally {
    await s.close();
  }
});
test("调用层级候选不透明data保留，跨线程及重启后标识失效", async () => {
  const s = await setup((root) => ({
    capabilities: { callHierarchyProvider: true },
    responses: {
      "textDocument/prepareCallHierarchy": [
        {
          name: "one",
          kind: 12,
          uri: pathToFileURL(join(root, "main.ts")).href,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          data: { opaque: ["unchanged", 42] },
        },
        {
          name: "two",
          kind: 12,
          uri: pathToFileURL(join(root, "main.ts")).href,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          data: { opaque: "second" },
        },
      ],
      "callHierarchy/incomingCalls": [],
    },
  }));
  try {
    const prepared = (await s.query("prepareCallHierarchy")) as any;
    assert.equal(prepared.callHierarchyItems.length, 2);
    const id = prepared.callHierarchyItems[1].callHierarchyItemId;
    assert.equal(
      ((await s.query("incomingCalls", { callHierarchyItemId: id })) as any)
        .status,
      "Empty",
    );
    const wire = (await fs.readFile(s.log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((v) => JSON.parse(v));
    assert.deepEqual(
      wire.find((v) => v.method === "callHierarchy/incomingCalls").params.item
        .data,
      { opaque: "second" },
    );
    assert.equal(
      (
        (await s.query(
          "incomingCalls",
          { callHierarchyItemId: id },
          "other",
        )) as any
      ).status,
      "StaleItem",
    );
    await s.core.restart(s.root, AbortSignal.timeout(5000));
    assert.equal(
      ((await s.query("incomingCalls", { callHierarchyItemId: id })) as any)
        .status,
      "StaleItem",
    );
  } finally {
    await s.close();
  }
});
test("超大语义结果有界且详情按线程隔离", async () => {
  const s = await setup({
    responses: {
      "textDocument/hover": {
        contents: { kind: "plaintext", value: "中文😀".repeat(18000) },
      },
    },
  });
  try {
    const result = (await s.query("hover")) as any;
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32000);
    const detail = s.core.detail("t", result.responseId, 0) as any;
    assert.equal(detail.text.length, 2000);
    assert.throws(
      () => s.core.detail("other", result.responseId, 0),
      /StaleItem/,
    );
  } finally {
    await s.close();
  }
});
test("Hook拒绝伪造agentId、缺元数据与畸形字段，单text符合事件契约", async () => {
  const s = await setup({ diagnostics: "pull" });
  try {
    const adapter = new CodexAdapter(s.core, join(s.root, "data"));
    const input = { sessionId: "shared", turnId: "turn", cwd: s.root };
    await assert.rejects(
      adapter.call(
        "diagnostics_on_prompt",
        input,
        {},
        AbortSignal.timeout(1000),
      ),
      /InvalidContext/,
    );
    await assert.rejects(
      adapter.call(
        "diagnostics_before_subagent_stop",
        {
          ...input,
          agentId: "forged",
          agentType: "worker",
          stopHookActive: false,
        },
        { threadId: "child" },
        AbortSignal.timeout(1000),
      ),
      /InvalidContext/,
    );
    const result = await adapter.call(
      "diagnostics_on_prompt",
      input,
      { threadId: "child" },
      AbortSignal.timeout(5000),
    );
    assert.equal(result.content.length, 1);
    assert.equal(
      JSON.parse(result.content[0].text).hookSpecificOutput.hookEventName,
      "UserPromptSubmit",
    );
    await assert.rejects(
      adapter.call(
        "diagnostics_after_tool",
        {
          ...input,
          toolName: "Bash",
          toolUseId: "tool",
          toolInput: null,
          toolResponse: "",
        },
        { threadId: "child" },
        AbortSignal.timeout(1000),
      ),
      /InvalidContext/,
    );
  } finally {
    await s.close();
  }
});
test("无版本Push反馈观察但不确认修复，等待可取消", async () => {
  const s = await setup({ diagnostics: "push", publishDelayMs: 10 });
  try {
    s.core.ledger.context("t", "session");
    await fs.writeFile(join(s.root, "main.ts"), "ERROR\n");
    await s.query("hover", { character: 1 });
    assert.ok(
      await waitUntil(() =>
        s.events.some((event) => event.event === "publishDiagnostics"),
      ),
    );
    await assert.rejects(s.core.reconcile(s.root, AbortSignal.timeout(300)));
    const output = s.core.ledger.collect("t", s.root, "event");
    assert.match(output, /current-diagnostics/);
    assert.match(output, /版本不确定/);
    assert.match(output, /新增归因未知/);
    assert.doesNotMatch(output, /resolved-diagnostics/);
  } finally {
    await s.close();
  }
});
test("回环控制鉴权、实例定位、真实目标重启及关闭清理", async () => {
  const s = await setup();
  let runtime: Awaited<ReturnType<typeof startControl>> | undefined;
  try {
    await s.query("hover");
    const data = join(s.root, "data");
    runtime = await startControl(data, s.core, [], AbortSignal.timeout(10000));
    const records = await runtimes(data, AbortSignal.timeout(1000));
    assert.equal(records.length, 1);
    const record = records[0];
    const denied = await fetch(record.endpoint, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer wrong" },
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(denied.status, 400);
    const before = s.core.status()[0].generation;
    await control(record, "restart", s.root, AbortSignal.timeout(5000));
    assert.ok(s.core.status()[0].generation > before);
    await assert.rejects(
      control(
        { ...record, instanceId: "forged" },
        "status",
        undefined,
        AbortSignal.timeout(1000),
      ),
      /StaleInstance/,
    );
    await runtime.close();
    runtime = undefined;
    assert.equal((await runtimes(data, AbortSignal.timeout(1000))).length, 0);
  } finally {
    await runtime?.close();
    await s.close();
  }
});
test("项目配置需内容摘要信任，改动立即失效，用户禁用上限保留", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "codex-lsp-trust-")),
  );
  try {
    const data = join(root, "data");
    const path = join(root, ".codex-lsp.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        servers: { clangd: { enabled: true, args: ["--background-index"] } },
      }),
    );
    assert.equal(
      Object.keys(
        (await projectOverrides(data, root, AbortSignal.timeout(1000))).servers,
      ).length,
      0,
    );
    await trustProject(data, root, AbortSignal.timeout(1000));
    assert.equal(
      (await projectOverrides(data, root, AbortSignal.timeout(1000))).servers
        .clangd.enabled,
      true,
    );
    await configure(
      data,
      "clangd",
      { enabled: false },
      AbortSignal.timeout(1000),
    );
    assert.equal(
      (await configuration(data, AbortSignal.timeout(1000))).servers.clangd
        .enabled,
      false,
    );
    await fs.appendFile(path, " ");
    assert.equal(
      Object.keys(
        (await projectOverrides(data, root, AbortSignal.timeout(1000))).servers,
      ).length,
      0,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Core关闭必须传播LS停止失败并保留原始原因", async () => {
  const s = await setup();
  await s.query("hover");
  const client = s.clients[0];
  const stop = client.stop.bind(client);
  client.stop = async () => {
    throw new Error("停止依赖失败标记");
  };
  try {
    await assert.rejects(s.core.close(), /LS停止失败.*停止依赖失败标记/);
  } finally {
    client.stop = stop;
    await stop();
    await fs.rm(s.root, { recursive: true, force: true });
  }
});
