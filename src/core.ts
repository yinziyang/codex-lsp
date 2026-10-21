import { configuredServers } from "./server-configuration.ts";
import { target } from "./servers.ts";
import { fileNotifications } from "./file-events.ts";
import { SemanticQueries } from "./semantic.ts";
import type { Instance, Workspace } from "./state.ts";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { LspClient, type ClientOptions } from "../extensions/pi-lsp/client.ts";
import { Router } from "../extensions/pi-lsp/routing.ts";
import { loadSettings, type LspSettings } from "../extensions/pi-lsp/config.ts";
import {
  DiagnosticLedger,
  parseDiagnostics,
  type Diagnostic,
} from "./diagnostics.ts";
import { WorkspaceIndex } from "./workspace.ts";
import {
  check,
  delay,
  uri,
  workspacePath,
  nodeEntry,
  type DiskFile,
} from "./platform.ts";
/** 协议与运行时依赖由入口注入，测试可替换真实网络、进程、时间与身份。 */
export interface CorePorts {
  dataRoot: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  identity: () => string;
  createClient: (options: ClientOptions) => LspClient;
  authorized: (root: string, signal: AbortSignal) => Promise<boolean>;
  serverOverrides: () => Record<string, unknown>;
  projectOverrides?: (
    workspace: string,
    signal: AbortSignal,
  ) => Promise<{
    servers: Record<string, Record<string, unknown>>;
    warnings: string[];
  }>;
  toolDirectories: () => string[];
  settings?: () => LspSettings;
  trace?: (event: unknown) => void;
}

/** 一个真实 MCP 进程拥有一个 Core，隐藏协议、文档和实例生命周期。 */
export class Core {
  readonly ledger = new DiagnosticLedger();
  private workspaces = new Map<string, Workspace>();
  private instances = new Map<string, Instance>();
  private semantics: SemanticQueries;
  private closing: Promise<void> | undefined;
  private lifetime = new AbortController();
  private sweep: NodeJS.Timeout;
  private ports: CorePorts;
  constructor(ports: CorePorts) {
    this.ports = ports;
    this.semantics = new SemanticQueries({
      workspace: (root, signal) => this.workspace(root, signal),
      instance: (w, file, signal) => this.instance(w, file, signal),
      sync: (i, file, signal) => this.sync(i, file, signal),
      identity: ports.identity,
      now: ports.now,
      trace: ports.trace,
    });
    this.sweep = setInterval(() => {
      for (const i of this.instances.values())
        if (!i.inflight && ports.now() - i.lastActive > 600000)
          void (i.restarting ??= (async () => {
            await i.client.stop();
            this.expire(i);
          })().finally(() => {
            i.restarting = undefined;
          })).catch(() => {});
      for (const w of this.workspaces.values())
        if (w.index.watch.dirty && !w.reconciling)
          void this.reconcile(
            w.root,
            AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(3000)]),
          ).catch(() => {});
    }, 1000);
    this.sweep.unref();
  }
  /** 列出本进程拥有的实例，不声称跨 Core 去重。 */
  status() {
    return [...this.instances.values()].map((i) => ({
      key: i.key,
      workspace: i.workspace,
      root: i.root,
      server: i.server.name,
      generation: i.generation,
      pid: i.client.pid,
      state: i.client.state,
      configuration: i.key.split("\0").at(-1),
      capabilities: i.client.capabilities,
      serverInfo: i.client.serverInfo,
      failures: i.failures,
    }));
  }
  private async workspace(
    root: string,
    signal: AbortSignal,
  ): Promise<Workspace> {
    check(signal);
    this.lifetime.signal.throwIfAborted();
    const actual = (await workspacePath(root, undefined, signal)).root;
    let w = this.workspaces.get(actual);
    if (w) return w;
    if (!(await this.ports.authorized(actual, signal)))
      throw new Error(
        "PermissionDenied：先通过 setup 审阅 LS 启动及构建脚本权限，再运行 CLI authorize。",
      );
    if (this.workspaces.size >= 16)
      throw new Error("ResourceLimit：工作区达到16个上限。");
    const loaded = this.ports.settings
      ? { settings: this.ports.settings(), warnings: [] }
      : loadSettings({
          agentDir: join(this.ports.dataRoot, "config"),
          cwd: actual,
          trusted: false,
        });
    const overrides = this.ports.serverOverrides();
    const project = await this.ports.projectOverrides?.(actual, signal);
    if (project) loaded.warnings.push(...project.warnings);
    const servers = configuredServers(
      loaded.settings.servers,
      overrides as Record<string, Record<string, unknown>>,
      project?.servers,
    )
      .filter((value) => value.enabled)
      .map((value) => value.config);
    const router = new Router(servers, {
      cwd: actual,
      toolDirs: this.ports.toolDirectories(),
      env: this.ports.env,
    });
    w = {
      root: actual,
      router,
      index: new WorkspaceIndex(actual),
      files: new Map(),
      complete: false,
      scanned: false,
      warnings: loaded.warnings,
    };
    this.workspaces.set(actual, w);
    return w;
  }
  private async instance(
    w: Workspace,
    file: string,
    signal: AbortSignal,
  ): Promise<Instance | undefined> {
    const server = w.router.serverFor(file);
    if (!server) return undefined;
    let root = w.router.rootFor(server, file);
    if (relative(w.root, root).startsWith("..")) root = w.root;
    const candidate = w.router.launchFor(server, file, root);
    if ("missing" in candidate)
      throw new Error(
        "Missing：" + candidate.missing + " 未找到，使用 manage 生成安装计划。",
      );
    if (/\.cmd$|\.bat$/i.test(candidate.command) && !server.builtin)
      throw new Error("Broken：自定义 cmd/bat 请配置真实解释器及脚本。");
    if (
      candidate.command !== process.execPath &&
      server.builtin &&
      ["typescript", "pyright", "html", "css"].includes(server.name)
    ) {
      candidate.args = [
        await nodeEntry(candidate.command, signal),
        ...candidate.args,
      ];
      candidate.command = process.execPath;
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          server,
          candidate.command,
          candidate.args,
          candidate.env,
        ]),
      )
      .digest("hex");
    const key = [w.root, root, server.name, fingerprint].join("\0");
    let i = this.instances.get(key);
    if (!i) {
      if (this.instances.size >= 24)
        throw new Error("ResourceLimit：LS 实例达到24个上限。");
      i = {
        key,
        workspace: w.root,
        root,
        server,
        launch: candidate,
        generation: 0,
        docs: new Map(),
        failures: 0,
        lastCrash: 0,
        inflight: 0,
        lastActive: this.ports.now(),
        observedPush: false,
        client: undefined as unknown as LspClient,
      };
      const inst = i;
      inst.client = this.ports.createClient({
        name: server.name,
        command: candidate.command,
        args: candidate.args,
        root,
        env: candidate.env,
        initializationOptions: candidate.initializationOptions,
        settings: candidate.settings,
        startupTimeout: 30000,
        requestTimeout: 60000,
        shutdownTimeout: 1000,
        pullDiagnostics: server.pullDiagnostics,
        diagnosticVersionSupport: true,
        fileEventSupport: true,
        trace: (event) =>
          this.ports.trace?.({ instance: key, ...(event as object) }),
        onDiagnostics: (p) => {
          if (!p || typeof p.uri !== "string") return;
          const diagnostics = parseDiagnostics(p.diagnostics);
          if (!diagnostics) return;
          inst.observedPush = true;
          this.ports.trace?.({
            event: "publishDiagnostics",
            instance: key,
            generation: inst.generation,
            params: p,
          });
          this.ledger.receive(
            p.uri,
            key + ":push",
            diagnostics,
            p.version ?? undefined,
            inst.generation,
            undefined,
            false,
            inst.workspace,
          );
        },
        onDiagnosticsRefresh: () => {
          for (const file of inst.docs.keys())
            void this.pull(inst, file, this.lifetime.signal).catch(() => {});
        },
        onCrash: () => {
          inst.failures++;
          inst.lastCrash = this.ports.now();
          this.expire(inst);
          w.index.watch.dirty = true;
        },
        readiness: { minMs: 1000, quietMs: 250, maxMs: 10000 },
      });
      this.instances.set(key, inst);
    }
    await this.running(i, signal);
    return i;
  }
  /** 失效只改变可信度，不把崩溃、空闲回收或重启合成为空诊断。 */
  private expire(i: Instance): void {
    i.generation++;
    for (const [file, doc] of i.docs)
      this.ledger.edit(
        i.workspace,
        uri(file),
        doc.version,
        i.generation,
        this.channels(i),
      );
    i.docs.clear();
  }
  private channels(i: Instance): string[] {
    return [
      ...(!i.client.supportsPullDiagnostics || i.observedPush
        ? [i.key + ":push"]
        : []),
      ...(i.client.supportsPullDiagnostics ? [i.key + ":pull"] : []),
    ];
  }
  private async running(i: Instance, signal: AbortSignal): Promise<void> {
    check(signal);
    if (i.restarting) await this.abortable(i.restarting, signal);
    if (i.client.state === "running") return;
    if (i.lastCrash && !i.server.restartOnCrash)
      throw new Error("ServerError：用户已禁用崩溃恢复。");
    if (
      i.failures > 3 ||
      (i.lastCrash && this.ports.now() - i.lastCrash < 1000)
    )
      throw new Error("ServerError：崩溃恢复达到上限或正在冷却。");
    if (!i.starting) {
      i.generation++;
      i.docs.clear();
      i.starting = i.client
        .start()
        .catch((error) => {
          i.failures++;
          i.lastCrash = this.ports.now();
          throw error;
        })
        .finally(() => {
          i.starting = undefined;
        });
    }
    await this.abortable(i.starting, signal);
  }
  private async abortable<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    onAbort = () => {},
  ): Promise<T> {
    check(signal);
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          abort = () => {
            onAbort();
            reject(signal.reason ?? new Error("Cancelled"));
          };
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async sync(
    i: Instance,
    file: DiskFile,
    signal: AbortSignal,
  ): Promise<void> {
    check(signal);
    const old = i.docs.get(file.file);
    if (old?.hash === file.hash) return;
    const version = (old?.version ?? 0) + 1;
    const sync = i.client.capabilities.textDocumentSync;
    const mode = typeof sync === "number" ? sync : (sync?.change ?? 0);
    const open = typeof sync === "number" || sync?.openClose === true;
    const save = typeof sync === "object" && sync?.save;
    this.ledger.edit(
      i.workspace,
      uri(file.file),
      version,
      i.generation,
      this.channels(i),
    );
    if (!old) {
      if (open)
        i.client.notify("textDocument/didOpen", {
          textDocument: {
            uri: uri(file.file),
            languageId:
              i.server.extensionToLanguage[
                file.file.slice(file.file.lastIndexOf("."))
              ] ?? "plaintext",
            version,
            text: file.text,
          },
        });
    } else if (mode !== 0) {
      const change =
        mode === 2
          ? {
              range: {
                start: { line: 0, character: 0 },
                end: {
                  line: old.text.split("\n").length - 1,
                  character: old.text.split("\n").at(-1)!.length,
                },
              },
              text: file.text,
            }
          : { text: file.text };
      i.client.notify("textDocument/didChange", {
        textDocument: { uri: uri(file.file), version },
        contentChanges: [change],
      });
    }
    if (save)
      i.client.notify("textDocument/didSave", {
        textDocument: { uri: uri(file.file) },
        ...(typeof save === "object" && save.includeText
          ? { text: file.text }
          : {}),
      });
    const workspace = this.workspaces.get(i.workspace);
    const event = old
      ? 2
      : workspace?.scanned && !workspace.files.has(file.file)
        ? 1
        : undefined;
    if (event)
      for (const notification of fileNotifications(
        i.client.capabilities,
        i.client.registrationOptions,
        i.root,
        file.file,
        event,
      ))
        i.client.notify(notification.method, notification.params);
    i.docs.set(file.file, {
      opened: open,
      text: file.text,
      hash: file.hash,
      version,
    });
    i.lastActive = this.ports.now();
    await this.pull(i, file.file, signal);
  }
  private async pull(
    i: Instance,
    file: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!i.client.supportsPullDiagnostics) return;
    const doc = i.docs.get(file);
    if (!doc) return;
    const version = doc.version;
    const generation = i.generation;
    const channel = i.key + ":pull";
    const prior = this.ledger.previous(uri(file), channel, i.workspace);
    const result = await i.client.request<{
      kind: string;
      items?: Diagnostic[];
      resultId?: string;
    }>(
      "textDocument/diagnostic",
      {
        textDocument: { uri: uri(file) },
        ...(prior?.resultId ? { previousResultId: prior.resultId } : {}),
      },
      signal,
    );
    const parsed = parseDiagnostics(result.items);
    if (result.kind === "full" && parsed)
      this.ledger.receive(
        uri(file),
        channel,
        parsed,
        version,
        generation,
        result.resultId,
        false,
        i.workspace,
      );
    else if (result.kind === "unchanged" && prior?.resultId)
      this.ledger.receive(
        uri(file),
        channel,
        prior.items,
        version,
        generation,
        result.resultId ?? prior.resultId,
        false,
        i.workspace,
      );
  }
  /** 监听与 Hook 共用内容摘要对账，不从 Shell 命令猜写集合。 */
  async reconcile(
    root: string,
    signal: AbortSignal,
  ): Promise<{ complete: boolean; warnings: string[] }> {
    const w = await this.workspace(root, signal);
    if (w.reconciling) {
      await this.abortable(w.reconciling, signal);
      return { complete: w.complete, warnings: w.warnings };
    }
    w.reconciling = (async () => {
      const next = await w.index.readBatch(signal);
      w.complete = next.complete;
      w.warnings = next.warnings;
      for (const file of next.files.values()) {
        check(signal);
        if (
          [...this.instances.values()].some(
            (i) =>
              i.workspace === w.root &&
              i.client.state === "running" &&
              i.docs.get(file.file)?.hash === file.hash,
          )
        )
          continue;
        try {
          const i = await this.instance(w, file.file, signal);
          if (i) await this.sync(i, file, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          w.warnings.push(String(error));
          w.index.watch.dirty = true;
          w.complete = false;
        }
      }
      if (next.complete)
        for (const file of w.files.keys())
          if (!next.files.has(file)) {
            for (const i of this.instances.values())
              if (i.workspace === w.root && i.docs.has(file)) {
                const doc = i.docs.get(file)!;
                i.docs.delete(file);
                if (i.client.state === "running" && doc.opened)
                  i.client.notify("textDocument/didClose", {
                    textDocument: { uri: uri(file) },
                  });
                if (i.client.state === "running")
                  for (const notification of fileNotifications(
                    i.client.capabilities,
                    i.client.registrationOptions,
                    i.root,
                    file,
                    3,
                  ))
                    i.client.notify(notification.method, notification.params);
              }
            this.ledger.deleted(uri(file), w.root);
          }
      if (next.complete) {
        w.files = next.files;
        w.scanned = true;
      } else for (const [file, value] of next.files) w.files.set(file, value);
      w.index.watch.dirty = !w.complete;
      while (this.ledger.pending(w.root)) await delay(25, signal);
    })().finally(() => {
      w.reconciling = undefined;
    });
    await w.reconciling;

    return { complete: w.complete, warnings: w.warnings };
  }
  /** 统一查询入口共享协议与诊断状态。 */
  async query(
    thread: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.semantics.query(thread, input, signal);
  }

  /** 获取当前线程的语义详情分页。 */
  detail(thread: string, id: string, offset: number): unknown {
    return this.semantics.detail(thread, id, offset);
  }

  /** 在当前Core的明确工作区重启指定Server的全部项目根，省略Server保留整工作区行为。 */
  async restart(
    root: string,
    signal: AbortSignal,
    server?: string,
  ): Promise<void> {
    const selectedServer = server === undefined ? undefined : target(server);
    const actual = (await workspacePath(root, undefined, signal)).root;
    const instances = [...this.instances.values()].filter(
      (i) =>
        i.workspace === actual &&
        (selectedServer === undefined || i.server.name === selectedServer),
    );
    if (!instances.length)
      throw new Error("StaleInstance：目标工作区或Server没有可重启实例。");
    await Promise.all(
      instances.map(async (i) => {
        check(signal);
        if (!i.restarting)
          i.restarting = (async () => {
            if (i.starting) await i.starting.catch(() => {});
            await i.client.stop();
            this.expire(i);
            i.failures = 0;
            i.lastCrash = 0;
          })().finally(() => {
            i.restarting = undefined;
          });
        await this.abortable(i.restarting, signal);
      }),
    );
    await Promise.all(instances.map((i) => this.running(i, signal)));
    this.workspaces.get(actual)!.index.watch.dirty = true;
  }
  /** 停止监听和在途等待，所有 LS 并行有界关闭，重复调用安全。 */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      clearInterval(this.sweep);
      this.lifetime.abort(new Error("Core 正在关闭。"));
      for (const w of this.workspaces.values()) w.index.close();
      await Promise.allSettled(
        [...this.workspaces.values()].map((w) => w.reconciling),
      );
      const stopped = await Promise.allSettled(
        [...this.instances.values()].map((i) => i.client.stop()),
      );
      const failures = stopped.filter(
        (value): value is PromiseRejectedResult => value.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((value) => value.reason),
          "LS停止失败，保留租约并核实残留：" +
            failures
              .map((value) => String(value.reason))
              .join("，")
              .slice(0, 2000),
        );
    })());
  }
}
