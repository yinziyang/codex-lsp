import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Core } from "./core.ts";
import { check, workspacePath } from "./platform.ts";
import { installPlan } from "./assets.ts";

const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const fields = {
  sessionId: { type: "string" },
  turnId: { type: "string" },
  cwd: { type: "string" },
};
const descriptions: Record<string, string> = {
  lsp_detail:
    "按 responseId 读取当前线程的大型语义结果分页，offset 为 UTF-16 码元偏移。",
  lsp: "优先用于定义、引用、实现、类型文档、符号与调用关系查询。workspaceRoot 必须是经过授权的项目绝对路径，行列为一基 UTF-16。Unsupported 时回退文本搜索。",
  diagnostics_before_tool:
    "供可信 PreToolUse Hook 建立写前基线，不安装或修改源码。",
  diagnostics_after_tool:
    "供 PostToolUse Hook 对账磁盘并返回同轮只读诊断，包括失败 Shell 的部分写入。",
  diagnostics_before_stop: "主线程 Stop 的有界末尾补偿，最多延续一次。",
  diagnostics_before_subagent_stop:
    "线程型子代理 SubagentStop 补偿，只消费宿主当前线程。",
  diagnostics_on_prompt: "在 UserPromptSubmit 冲刷空闲期间的外部变更。",
  diagnostics_remaining:
    "使用上一批 cursor 获取当前线程未展示诊断，批次支持幂等重放。",
  diagnostics_detail:
    "读取当前线程已观察到的完整诊断，摘要不会被冒充完整送达。",
  lsp_manage:
    "只读查看支持服务器、本连接实例及安装计划，不自动下载或清理资产。",
};
/** MCP 参数统一在信任边界校验，诊断 Hook 只能执行固定只读操作。 */
export class CodexAdapter {
  private core: Core;
  private root: string;
  private audit: ((event: unknown) => void) | undefined;
  constructor(core: Core, root: string, audit?: (event: unknown) => void) {
    this.audit = audit;
    this.core = core;
    this.root = root;
  }
  /** 暴露九操作单入口及独立 Hook 入口。 */
  tools(): unknown[] {
    const hookProperties: Record<string, unknown> = {
      ...fields,
      toolUseId: { type: "string" },
      toolName: { type: "string", enum: ["apply_patch", "Bash"] },
      toolInput: { type: "object" },
      toolResponse: {},
      stopHookActive: { type: "boolean" },
      agentId: { type: "string" },
      agentType: { type: "string" },
    };
    const schemas: Record<
      string,
      { properties: Record<string, unknown>; required: string[] }
    > = {
      lsp: {
        properties: {
          operation: {
            type: "string",
            enum: [
              "goToDefinition",
              "findReferences",
              "hover",
              "documentSymbol",
              "workspaceSymbol",
              "goToImplementation",
              "prepareCallHierarchy",
              "incomingCalls",
              "outgoingCalls",
            ],
          },
          workspaceRoot: { type: "string" },
          filePath: { type: "string" },
          line: { type: "integer", minimum: 1 },
          character: { type: "integer", minimum: 1 },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          callHierarchyItemId: { type: "string" },
        },
        required: [
          "operation",
          "workspaceRoot",
          "filePath",
          "line",
          "character",
        ],
      },
      lsp_detail: {
        properties: {
          responseId: { type: "string" },
          offset: { type: "integer", minimum: 0 },
        },
        required: ["responseId"],
      },
      lsp_manage: {
        properties: {
          action: { type: "string", enum: ["list", "doctor", "plan-install"] },
          language: { type: "string" },
        },
        required: ["action"],
      },
      diagnostics_detail: {
        properties: { diagnosticId: { type: "string" } },
        required: ["diagnosticId"],
      },
      diagnostics_remaining: {
        properties: { cursor: { type: "string" } },
        required: ["cursor"],
      },
    };
    for (const [name, required] of Object.entries({
      diagnostics_before_tool: ["toolUseId", "toolName", "toolInput"],
      diagnostics_after_tool: [
        "toolUseId",
        "toolName",
        "toolInput",
        "toolResponse",
      ],
      diagnostics_before_stop: ["stopHookActive"],
      diagnostics_before_subagent_stop: [
        "agentId",
        "agentType",
        "stopHookActive",
      ],
      diagnostics_on_prompt: [],
    }))
      schemas[name] = {
        properties: hookProperties,
        required: ["sessionId", "turnId", "cwd", ...required],
      };
    return Object.entries(descriptions).map(([name, description]) => ({
      name,
      description,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        ...schemas[name],
        additionalProperties: false,
      },
    }));
  }
  private thread(metadata: unknown): string {
    if (
      !object(metadata) ||
      typeof metadata.threadId !== "string" ||
      !metadata.threadId ||
      metadata.threadId.length > 256
    )
      throw new Error("InvalidContext：缺少可信宿主 metadata.threadId。");
    return metadata.threadId;
  }
  /** 每个 Hook 总预算3秒，返回一个合法事件 JSON 的文本块。 */
  async call(
    name: string,
    input: unknown,
    metadata: unknown,
    signal: AbortSignal,
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    if (!object(input)) throw new Error("InvalidInput：参数必须是对象。");
    check(signal);
    if (name === "lsp_manage") {
      if (!["list", "doctor", "plan-install"].includes(String(input.action)))
        throw new Error("InvalidInput：管理动作不受支持。");
      const value =
        input.action === "plan-install"
          ? installPlan(String(input.language ?? ""), this.root)
          : {
              servers: [
                "gopls",
                "rust-analyzer",
                "clangd",
                "typescript",
                "pyright",
                "html",
                "css",
              ],
              instances: this.core.status(),
              dataRoot: this.root,
              connection:
                "当前工具调用证明 MCP 已连接，Hook 信任需在 /hooks 检查。",
            };
      return this.text(value);
    }
    const thread = this.thread(metadata);
    if (name === "lsp_detail") {
      if (typeof input.responseId !== "string")
        throw new Error("InvalidInput：缺少 responseId。");
      return this.text(
        this.core.detail(thread, input.responseId, Number(input.offset ?? 0)),
      );
    }
    if (name === "lsp") {
      try {
        return this.text(await this.core.query(thread, input, signal));
      } catch (error) {
        if (/InvalidInput|PermissionDenied|InvalidContext/.test(String(error)))
          throw error;
        return this.text({
          status: signal.aborted
            ? "Cancelled"
            : /timed out/.test(String(error))
              ? "Timeout"
              : "ServerError",
          message: String(error).slice(0, 2000),
        });
      }
    }
    if (name === "diagnostics_remaining") {
      if (typeof input.cursor !== "string")
        throw new Error("InvalidInput：缺少 cursor。");
      return this.text({
        additionalContext: this.core.ledger.remaining(thread, input.cursor),
      });
    }
    if (name === "diagnostics_detail") {
      if (typeof input.diagnosticId !== "string")
        throw new Error("InvalidInput：缺少 diagnosticId。");
      return this.text(this.core.ledger.detail(thread, input.diagnosticId));
    }
    if (!name.startsWith("diagnostics_") || !descriptions[name])
      throw new Error("MethodNotFound：工具不存在。");
    for (const field of ["sessionId", "turnId", "cwd"])
      if (
        typeof input[field] !== "string" ||
        !input[field] ||
        String(input[field]).length > 4096
      )
        throw new Error("InvalidContext：" + field + " 缺失或类型错误。");
    if (
      name === "diagnostics_before_subagent_stop" &&
      (input.agentId !== thread || typeof input.agentType !== "string")
    )
      throw new Error(
        "InvalidContext：SubagentStop agentId 与宿主线程不一致。",
      );
    if (
      name === "diagnostics_before_tool" ||
      name === "diagnostics_after_tool"
    ) {
      if (
        typeof input.toolUseId !== "string" ||
        !["apply_patch", "Bash"].includes(String(input.toolName)) ||
        !object(input.toolInput)
      )
        throw new Error("InvalidContext：工具事件缺少稳定字段。");
      if (name === "diagnostics_after_tool" && input.toolResponse === undefined)
        throw new Error("InvalidContext：缺少 toolResponse。");
    }
    const stop =
      name === "diagnostics_before_stop" ||
      name === "diagnostics_before_subagent_stop";
    if (stop && typeof input.stopHookActive !== "boolean")
      throw new Error("InvalidContext：stopHookActive 必须为布尔值。");
    input.cwd = (
      await workspacePath(input.cwd as string, undefined, signal)
    ).root;
    this.core.ledger.context(thread, input.sessionId as string);
    this.audit?.({
      event: "hook",
      mcpPid: process.pid,
      threadId: thread,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      hook: name,
    });
    const budget = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    let state = "";
    try {
      const result = await this.core.reconcile(input.cwd as string, budget);
      if (!result.complete) state = "工作区扫描未完成。";
      if (result.warnings.length)
        state += "限制：" + result.warnings.slice(0, 3).join("，");
    } catch (error) {
      if (signal.aborted) throw error;
      state = budget.aborted
        ? "诊断超时，状态未知，不能宣称修复。"
        : String(error);
    }
    if (name === "diagnostics_before_tool") {
      this.core.ledger.baseline(thread, input.cwd as string);
      return this.text({});
    }
    const event = [thread, input.turnId, input.toolUseId ?? name, name].join(
      "/",
    );
    let text = this.core.ledger.collect(thread, input.cwd as string, event);
    if (state) {
      const prefix = Array.from(state).slice(0, 300).join("");
      if (Buffer.byteLength(text + "\n" + prefix) <= 8000)
        text += "\n" + prefix;
    }
    if (stop) {
      const hasIssues =
        text.includes("<new-diagnostics>") ||
        text.includes("<current-diagnostics>");
      return this.text(
        hasIssues &&
          this.core.ledger.continueOnce(
            thread,
            input.turnId as string,
            input.stopHookActive as boolean,
          )
          ? { decision: "block", reason: text }
          : {},
      );
    }
    const eventName =
      name === "diagnostics_after_tool" ? "PostToolUse" : "UserPromptSubmit";
    return this.text({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
    });
  }
  private text(value: unknown): { content: { type: "text"; text: string }[] } {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  }
}
/** JSON 行 MCP 传输支持取消、请求并发、输入上限与有界关闭。 */
export async function serve(
  adapter: CodexAdapter,
  input: Readable,
  output: Writable,
  lifetime: AbortSignal,
  identity: { version: string; sourceHash: string },
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  const abort = () => {
    lines.close();
    input.destroy();
    for (const p of pending.values()) p.abort.abort(lifetime.reason);
  };
  lifetime.addEventListener("abort", abort, { once: true });
  const send = (value: unknown) => {
    if (!output.destroyed) output.write(JSON.stringify(value) + "\n");
  };
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > 4_000_000) {
        send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "InvalidInput：请求超过4MB。" },
        });
        continue;
      }
      let request: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (
          !object(parsed) ||
          parsed.jsonrpc !== "2.0" ||
          typeof parsed.method !== "string"
        )
          throw new Error();
        request = parsed;
      } catch {
        send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        continue;
      }
      const params = object(request.params) ? request.params : {};
      if (request.method === "notifications/cancelled") {
        pending
          .get(String(params.requestId))
          ?.abort.abort(new Error("Cancelled"));
        continue;
      }
      if (request.id === undefined) continue;
      if (typeof request.id !== "number" && typeof request.id !== "string") {
        send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid request id" },
        });
        continue;
      }
      if (pending.size >= 64 || pending.has(String(request.id))) {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "ResourceLimit：并发上限或重复请求标识。",
          },
        });
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime, controller.signal]);
      const id = request.id;
      const promise = (async () => {
        try {
          let result: unknown;
          if (request.method === "initialize") {
            const version =
              typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : "2024-11-05";
            result = {
              protocolVersion: version,
              capabilities: { tools: {} },
              serverInfo: {
                name: "codex-lsp",
                version: identity.version,
                description: "构建输入 SHA256 " + identity.sourceHash,
              },
            };
          } else if (request.method === "ping") result = {};
          else if (request.method === "tools/list")
            result = { tools: adapter.tools() };
          else if (request.method === "tools/call") {
            if (typeof params.name !== "string")
              throw new Error("InvalidInput：工具名缺失。");
            result = await adapter.call(
              params.name,
              params.arguments,
              params._meta,
              signal,
            );
          } else {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: "Method not found" },
            });
            return;
          }
          send({ jsonrpc: "2.0", id, result });
        } catch (error) {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: signal.aborted ? "Cancelled" : String(error),
                },
              ],
              isError: true,
            },
          });
        }
      })().finally(() => pending.delete(String(id)));
      pending.set(String(id), { abort: controller, promise });
    }
  } finally {
    lifetime.removeEventListener("abort", abort);
    for (const p of pending.values())
      p.abort.abort(new Error("MCP 连接结束。"));
    await Promise.race([
      Promise.allSettled([...pending.values()].map((p) => p.promise)),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        timer.unref();
      }),
    ]);
  }
}
