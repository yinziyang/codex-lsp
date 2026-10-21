import { join } from "node:path";
import type { LspClient, ClientOptions } from "../extensions/pi-lsp/client.ts";
import { Router } from "../extensions/pi-lsp/routing.ts";
import { loadSettings } from "../extensions/pi-lsp/config.ts";
import { configuredServers } from "./server-configuration.ts";
import { configuration, projectOverrides } from "./configuration.ts";
import { check, nodeEntry } from "./platform.ts";
const extensions: Record<string, string> = {
  gopls: ".go",
  "rust-analyzer": ".rs",
  clangd: ".c",
  typescript: ".ts",
  pyright: ".py",
  html: ".html",
  css: ".css",
};
/** 实际 initialize/initialized 后有界退出，存在文件不等于 Ready。 */
export async function probeServer(
  root: string,
  serverName: string,
  workspace: string,
  directories: string[],
  signal: AbortSignal,
  createClient: (options: ClientOptions) => LspClient,
): Promise<unknown> {
  const settings = loadSettings({
    agentDir: join(root, "config"),
    cwd: workspace,
    trusted: false,
  }).settings;
  const config = await configuration(root, signal);
  const project = await projectOverrides(root, workspace, signal);
  const selected = configuredServers(
    settings.servers,
    config.servers,
    project.servers,
  ).find((value) => value.config.name === serverName);
  if (!selected?.enabled) throw new Error("Disabled：服务器已禁用。");
  const server = selected.config;
  const router = new Router([server], {
    cwd: workspace,
    toolDirs: directories,
    env: process.env,
  });
  const launch = router.launchFor(
    server,
    join(workspace, "probe" + extensions[serverName]),
    workspace,
  );
  if ("missing" in launch) throw new Error("Missing：" + launch.missing);
  if (
    server.builtin &&
    launch.command !== process.execPath &&
    ["typescript", "pyright", "html", "css"].includes(serverName)
  ) {
    launch.args = [await nodeEntry(launch.command, signal), ...launch.args];
    launch.command = process.execPath;
  }
  if (/\.(cmd|bat)$/i.test(launch.command))
    throw new Error("Broken：请配置真实解释器和脚本入口。");
  const client = createClient({
    name: serverName,
    ...launch,
    root: workspace,
    startupTimeout: Math.min(30000, 10000),
    requestTimeout: 5000,
    shutdownTimeout: 1000,
    pullDiagnostics: server.pullDiagnostics,
    onDiagnostics: () => {},
    onDiagnosticsRefresh: () => {},
    onCrash: () => {},
  });
  const abort = () => {
    void client.stop().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    check(signal);
    await client.start();
    check(signal);
    return {
      status: "Ready",
      server: serverName,
      path: launch.command,
      serverInfo: client.serverInfo ?? {
        name: serverName,
        version: "服务器未提供版本",
      },
      capabilities: client.capabilities,
      positionEncoding: client.capabilities.positionEncoding ?? "utf-16",
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await client.stop();
  }
}
