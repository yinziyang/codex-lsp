import { guardedClient } from "./client-binding.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Core } from "./core.ts";
import { loadSettings } from "../extensions/pi-lsp/config.ts";
import {
  TOOL_DESCRIPTION,
  PROMPT_GUIDELINES,
  PROMPT_SNIPPET,
} from "../extensions/pi-lsp/tool.ts";
import { OPERATIONS } from "../extensions/pi-lsp/format.ts";
import { dataRoot, execute } from "./platform.ts";
import { configuration } from "./configuration.ts";
import { assets, installPlan } from "./assets.ts";

/** Pi 与 Codex 使用同一 Core，适配器只负责宿主事件和展示。 */
export default function piAdapter(pi: ExtensionAPI): void {
  let core: Core | undefined;
  let context: ExtensionContext | undefined;
  let thread = "";
  let turn = 0;
  let lifetime = new AbortController();
  let root = "";
  const status = () => {
    if (!context?.hasUI || !core) return;
    const items = core.status() as { server: string; state: string }[];
    context.ui.setStatus(
      "zz-pi-lsp",
      items.length
        ? "LSP " +
            items
              .map(
                (i) =>
                  i.server +
                  " " +
                  (i.state === "running"
                    ? "✓"
                    : i.state === "starting"
                      ? "…"
                      : "✗"),
              )
              .join(" · ")
        : "LSP idle",
    );
  };
  const flush = async (
    id: string,
    deliverAs: "steer" | "nextTurn",
    signal: AbortSignal,
  ) => {
    if (!core || !context) return;
    try {
      await core.reconcile(context.cwd, signal);
    } catch {}
    const text = core.ledger.collect(thread, context.cwd, id);
    if (
      /<(new|current)-diagnostics>|文件已删除|resolved-diagnostics/.test(text)
    )
      pi.sendMessage(
        {
          customType: "lsp-diagnostics",
          content: text,
          display: true,
          details: {
            files: 0,
            issues: (text.match(/<(new|current)-diagnostics>/g) ?? []).length,
          },
        },
        { deliverAs },
      );
    status();
  };
  pi.registerMessageRenderer(
    "lsp-diagnostics",
    (message, { expanded, outputPad }, theme) => {
      const d = message.details as { issues?: number } | undefined;
      const summary = d?.issues
        ? `发现 ${d.issues} 项诊断。`
        : "诊断状态更新。";
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(
        new Text(
          expanded ? summary + "\n" + String(message.content) : summary,
          0,
          0,
        ),
      );
      return box;
    },
  );
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    thread = randomUUID();
    lifetime = new AbortController();
    root = dataRoot(process.env, process.platform);
    const config = await configuration(root, lifetime.signal);
    const owned = await assets(root, lifetime.signal);
    const settings = loadSettings({
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      trusted: ctx.isProjectTrusted(),
    });
    core = new Core({
      dataRoot: root,
      env: process.env,
      now: () => Date.now(),
      identity: () => randomUUID(),
      createClient: (opts) =>
        guardedClient(
          opts,
          join(import.meta.dirname, "..", "plugins/codex-lsp/dist/guard.js"),
          root,
          thread,
        ),
      authorized: async (workspace) =>
        workspace === ctx.cwd &&
        (ctx.isProjectTrusted() ||
          config.authorizedWorkspaces.includes(workspace)),
      serverOverrides: () => config.servers,
      toolDirectories: () => owned.map((x) => x.binDirectory),
      settings: () => settings.settings,
    });
    core.ledger.context(thread, thread);
    status();
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!core || !["edit", "write", "bash"].includes(event.toolName)) return;
    const signal = AbortSignal.any([
      lifetime.signal,
      ctx.signal ?? lifetime.signal,
      AbortSignal.timeout(3000),
    ]);
    try {
      await core.reconcile(ctx.cwd, signal);
      core.ledger.baseline(thread, ctx.cwd);
    } catch {}
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!["edit", "write", "bash"].includes(event.toolName)) return;
    await flush(
      `${turn}/${event.toolCallId}`,
      "steer",
      AbortSignal.any([
        lifetime.signal,
        ctx.signal ?? lifetime.signal,
        AbortSignal.timeout(3000),
      ]),
    );
  });
  pi.on("agent_end", async () => {
    await flush(
      `${turn++}/end`,
      "nextTurn",
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
    );
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    await core?.close();
    core = undefined;
    if (context?.hasUI) context.ui.setStatus("zz-pi-lsp", undefined);
    context = undefined;
  });
  const parameters = Type.Object({
    operation: Type.Union(OPERATIONS.map((value) => Type.Literal(value))),
    filePath: Type.String(),
    line: Type.Integer({ minimum: 1 }),
    character: Type.Integer({ minimum: 1 }),
    query: Type.Optional(Type.String()),
    callHierarchyItemId: Type.Optional(Type.String()),
  });
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: TOOL_DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters,
    executionMode: "parallel",
    async execute(_id, params, signal) {
      if (!core || !context)
        return {
          content: [{ type: "text", text: "LSP 尚未初始化。" }],
          details: {},
        };
      const result = await core.query(
        thread,
        { ...params, workspaceRoot: context.cwd },
        AbortSignal.any([lifetime.signal, signal ?? lifetime.signal]),
      );
      status();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  });
  pi.registerCommand("lsp", {
    description: "LSP 状态、安装与重启。",
    getArgumentCompletions: (prefix) =>
      ["install", "restart"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [action, language] = args.trim().split(/\s+/);
      if (!core) return ctx.ui.notify("LSP 尚未初始化。", "warning");
      if (action === "restart") {
        await core.restart(ctx.cwd, AbortSignal.timeout(10000));
        status();
        return;
      }
      if (action === "install") {
        if (!language) return ctx.ui.notify("需要语言名。", "warning");
        const plan = installPlan(language, root);
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm("安装语言服务器？", JSON.stringify(plan)))
        )
          return;
        await execute(
          process.execPath,
          [
            join(
              import.meta.dirname,
              "..",
              "plugins",
              "codex-lsp",
              "dist",
              "cli.js",
            ),
            "install",
            language,
            "--workspace",
            ctx.cwd,
          ],
          AbortSignal.any([lifetime.signal, AbortSignal.timeout(600000)]),
        );
        ctx.ui.notify("安装及 initialize 验证完成，请重启会话。", "info");
        return;
      }
      ctx.ui.notify(JSON.stringify(core.status()), "info");
    },
  });
}
