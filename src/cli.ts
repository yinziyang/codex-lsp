import { probeServer } from "./doctor.ts";
import { guardedClient } from "./client-binding.ts";
import { guardLeases } from "./guard-leases.ts";
import { target } from "./servers.ts";
import { promises as fs } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { loadSettings } from "../extensions/pi-lsp/config.ts";
import { Core } from "./core.ts";
import { CodexAdapter, serve } from "./mcp.ts";
import { dataRoot, findCommand, atomicJson } from "./platform.ts";
import {
  configuration,
  authorize,
  configure,
  trustProject,
  projectOverrides,
  locked,
} from "./configuration.ts";
import {
  assets,
  install,
  installPlan,
  uninstall,
  type Asset,
} from "./assets.ts";
import { runtimes, control, startControl } from "./runtime.ts";

declare const __BUILD_HASH__: string;
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "development";
const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf("--" + name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("缺少参数 --" + name);
  args.splice(index, 2);
  return value;
}
const explicitRoot = option("data-root");
const root = explicitRoot
  ? resolve(explicitRoot)
  : dataRoot(process.env, process.platform);
const explicitWorkspace = option("workspace");
const workspace = resolve(explicitWorkspace ?? process.cwd());
const command = args.shift() ?? "help";
const lifetime = new AbortController();
const stop = () => lifetime.abort(new Error("收到终止信号。"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const print = (value: unknown) =>
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const trace =
  process.env.CODEX_LSP_TRACE === "1"
    ? (event: unknown) => {
        const path = join(root, "logs", "protocol.jsonl");
        void fs
          .mkdir(dirname(path), { recursive: true, mode: 0o700 })
          .then(async () => {
            let st;
            try {
              st = await fs.stat(path);
            } catch {}
            if (st && st.size > 5_000_000) await fs.rename(path, path + ".1");
            await fs.appendFile(path, JSON.stringify(event) + "\n", {
              mode: 0o600,
            });
          })
          .catch(() => {});
      }
    : undefined;
async function main(): Promise<void> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18))
    throw new Error("Node >=22.18 为前置条件，插件不会自动安装运行时。");
  if (command === "--version" || command === "version") {
    print({
      version: VERSION,
      sourceBuild:
        typeof __BUILD_HASH__ === "string" ? __BUILD_HASH__ : "development",
    });
    return;
  }
  if (command === "help" || command === "--help") {
    print({
      commands: [
        "serve",
        "list",
        "doctor --workspace <绝对路径>",
        "plan <语言>",
        "install <语言>",
        "install-asset rust --url <官方gz> --sha256 <校验> --version <固定版本>",
        "authorize --workspace <绝对路径>",
        "configure <语言> --json <对象>",
        "restart [Server或语言别名] --instance <ID> --workspace <绝对路径>，省略Server重启该工作区全部Server及项目根",
        "uninstall <语言>",
        "purge",
        "instances",
        "version",
      ],
      permission:
        "LS 可读写项目并可能运行构建脚本，先审阅并 authorize 工作区。",
    });
    return;
  }
  const signal = lifetime.signal;
  if (command === "authorize") {
    await authorize(root, workspace, signal);
    print({
      authorized: workspace,
      notice: "语言服务器可能执行项目构建脚本，授权记录仅此工作区。",
    });
    return;
  }
  if (command === "trust-project") {
    print({
      workspace,
      configHash: await trustProject(root, workspace, signal),
      newProcessRequired: true,
    });
    return;
  }
  if (command === "configure") {
    const json = option("json");
    if (!json) throw new Error("缺少 --json 配置对象。");
    const value = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("配置必须为对象。");
    await configure(root, args[0] ?? "", value, signal);
    print({ configured: target(args[0]), newProcessRequired: true });
    return;
  }
  if (command === "plan") {
    print(installPlan(args[0] ?? "", root));
    return;
  }
  if (command === "install") {
    const asset = await install(
      root,
      args[0] ?? "",
      signal,
      async (bin, name) => {
        await probeServer(root, name, workspace, [bin], signal, (options) =>
          guardedClient(
            options,
            join(import.meta.dirname, "guard.js"),
            root,
            "doctor-" + randomUUID(),
          ),
        );
      },
    );
    print({ status: "Ready", asset });
    return;
  }
  if (command === "install-asset") {
    const url = option("url");
    const checksum = option("sha256");
    const version = option("version");
    if (
      target(args[0] ?? "") !== "rust-analyzer" ||
      !url ||
      !checksum ||
      !/^[a-f0-9]{64}$/.test(checksum) ||
      !version ||
      !/^[a-zA-Z0-9._-]+$/.test(version) ||
      !url.startsWith(
        "https://github.com/rust-lang/rust-analyzer/releases/download/",
      ) ||
      !url.endsWith(".gz")
    )
      throw new Error(
        "必须提供固定版本、官方 rust-analyzer gz URL 和 SHA256。",
      );
    await locked(root, signal, async () => {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
      if (!response.ok) throw new Error("下载失败：" + response.status);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("下载内容缺失。");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        bytes += value.value.length;
        if (bytes > 128_000_000) {
          await reader.cancel();
          throw new Error("下载超过128MB上限。");
        }
        chunks.push(value.value);
      }
      const archive = Buffer.concat(chunks);
      if (createHash("sha256").update(archive).digest("hex") !== checksum)
        throw new Error("IntegrityError：下载校验失败。");
      const transaction = randomUUID();
      const directory = join(root, "assets", "rust-analyzer-" + transaction);
      const bin = join(directory, "bin");
      await fs.mkdir(bin, { recursive: true, mode: 0o700 });
      const path = join(
        bin,
        process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer",
      );
      try {
        await fs.writeFile(
          path,
          gunzipSync(archive, { maxOutputLength: 256_000_000 }),
          { mode: 0o700 },
        );
        await probeServer(
          root,
          "rust-analyzer",
          workspace,
          [bin],
          signal,
          (options) =>
            guardedClient(
              options,
              join(import.meta.dirname, "guard.js"),
              root,
              "doctor-" + randomUUID(),
            ),
        );
        const previous = (await assets(root, signal)).find(
          (value) => value.unit === "rust-analyzer",
        );
        const asset: Asset = {
          schemaVersion: 1,
          creator: "codex-lsp",
          transaction,
          unit: "rust-analyzer",
          path: directory,
          version,
          checksum,
          consumers: ["rust-analyzer"],
          binDirectory: bin,
          source: url,
          retained: previous
            ? [
                ...(previous.retained ?? []),
                {
                  path: previous.path,
                  transaction: previous.transaction,
                  checksum: previous.checksum,
                  version: previous.version,
                },
              ]
            : undefined,
        };
        await atomicJson(
          join(root, "ownership", "rust-analyzer.json"),
          asset,
          signal,
        );
        print({ status: "Ready", asset });
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
    return;
  }
  if (command === "uninstall") {
    await uninstall(root, args[0] ?? "", signal);
    print({ removed: target(args[0]) });
    return;
  }
  if (command === "purge") {
    const owned = await assets(root, signal);
    for (const asset of owned)
      for (const language of [...asset.consumers])
        await uninstall(root, language, signal);
    print({ purged: "仅当前所有权记录内资产。", configPreserved: true });
    return;
  }
  if (command === "instances" || command === "restart") {
    const instanceId = option("instance");
    if (command === "restart" && (!instanceId || !explicitWorkspace))
      throw new Error("重启必须显式提供 --instance 和 --workspace。");
    if (
      args.length > (command === "restart" ? 1 : 0) ||
      args.some((value) => value.startsWith("--")) ||
      (command === "instances" && instanceId)
    )
      throw new Error("InvalidInput：未知、重复或冲突的定位参数。");
    const server =
      command === "restart" && args.length ? target(args[0]) : undefined;
    const list = await runtimes(root, signal);
    if (command === "restart") {
      const selected = list.filter((x) => x.instanceId === instanceId);
      if (selected.length !== 1)
        throw new Error("StaleInstance：目标不唯一或已失效。");
      print(await control(selected[0], "restart", workspace, signal, server));
    } else {
      const result = [];
      for (const record of list) {
        try {
          result.push(await control(record, "status", undefined, signal));
        } catch {
          result.push({
            instanceId: record.instanceId,
            status: "StaleInstance",
          });
        }
      }
      print({
        instances: result,
        guards: (await guardLeases(root, signal)).map((value) => ({
          coreId: value.lease.coreId,
          server: value.lease.server,
          state: value.state,
          guardPid: value.lease.guardPid,
          childPid: value.lease.childPid,
        })),
      });
    }
    return;
  }
  const config = await configuration(root, signal);
  const owned = await assets(root, signal);
  const directories = owned.map((x) => x.binDirectory);
  if (command === "list" || command === "doctor") {
    const settings = loadSettings({
      agentDir: join(root, "config"),
      cwd: workspace,
      trusted: false,
    }).settings;
    const result = [];
    for (const server of settings.servers) {
      if (config.servers[server.name]?.enabled === false) {
        result.push({ server: server.name, status: "Disabled" });
        continue;
      }
      if (command === "doctor") {
        if (!config.authorizedWorkspaces.includes(workspace)) {
          result.push({
            server: server.name,
            status: "PermissionRequired",
            reason: "先审阅并 authorize 工作区。",
          });
          continue;
        }
        try {
          result.push(
            await probeServer(
              root,
              server.name,
              workspace,
              directories,
              signal,
              (options) =>
                guardedClient(
                  options,
                  join(import.meta.dirname, "guard.js"),
                  root,
                  "doctor-" + randomUUID(),
                ),
            ),
          );
        } catch (error) {
          result.push({
            server: server.name,
            status: String(error).includes("Missing") ? "Missing" : "Broken",
            reason: String(error),
          });
        }
      } else {
        const command =
          (config.servers[server.name]?.command as string) ?? server.command;
        const path = await findCommand(
          command,
          process.env,
          process.platform,
          signal,
          directories,
        );
        result.push({
          server: server.name,
          status: path ? "Installed" : "Missing",
          path,
          readiness: "仅 doctor 真实初始化后才报告 Ready。",
        });
      }
    }
    print({
      servers: result,
      assets: owned,
      automaticFeedback: {
        enabled: "须在宿主 Plugin 管理中确认。",
        trusted: "须在 /hooks 审阅当前定义。",
        connected: "离线 doctor 不证明宿主已连接。",
        feedback: "必须运行不主动调用 MCP 的同轮错误夹具。",
      },
    });
    return;
  }
  if (command !== "serve") throw new Error("未知命令：" + command);
  let coreId = "starting";
  const core = new Core({
    dataRoot: root,
    env: process.env,
    now: () => Date.now(),
    identity: () => randomUUID(),
    createClient: (options) =>
      guardedClient(
        options,
        join(import.meta.dirname, "guard.js"),
        root,
        coreId,
      ),
    authorized: async (value, signal) =>
      (await configuration(root, signal)).authorizedWorkspaces.includes(value),
    serverOverrides: () => config.servers,
    projectOverrides: (workspace, signal) =>
      projectOverrides(root, workspace, signal),
    toolDirectories: () => directories,
    trace,
  });
  const runtime = await startControl(
    root,
    core,
    owned.flatMap((x) => x.consumers),
    signal,
  );
  coreId = runtime.instanceId;
  try {
    await serve(
      new CodexAdapter(core, root, trace),
      process.stdin,
      process.stdout,
      signal,
      {
        version: VERSION,
        sourceHash:
          typeof __BUILD_HASH__ === "string" ? __BUILD_HASH__ : "development",
      },
    );
  } finally {
    const timeout = setTimeout(() => {
      process.stderr.write(
        "关闭超过10秒，结束宿主并关闭管道，残留需独立核实。\n",
      );
      process.exit(1);
    }, 10000);
    timeout.unref();
    await runtime.close();
    await core.close();
    clearTimeout(timeout);
  }
}
main()
  .catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
