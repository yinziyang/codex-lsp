import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
const output = resolve(
  process.env.CODEX_LSP_EVIDENCE ?? ".artifacts/discovery",
);
await fs.mkdir(output, { recursive: true });
const results = [];
for (const enabled of [false, true]) {
  const child = spawn(
    "codex",
    [
      "app-server",
      "--stdio",
      "-c",
      `plugins.codex-lsp@codex-lsp-local.enabled=${enabled}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const pending = new Map();
  let sequence = 0;
  const deadline = setTimeout(() => child.kill("SIGTERM"), 30000);
  const hard = setTimeout(() => child.kill("SIGKILL"), 35000);
  child.on("exit", () => {
    for (const item of pending.values())
      item.reject(new Error("宿主提前退出。"));
    pending.clear();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (pending.has(value.id)) {
      pending.get(value.id).resolve(value);
      pending.delete(value.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    await request("initialize", {
      clientInfo: { name: "codex-lsp-discovery", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n",
    );
    const hooks = await request("hooks/list", { cwds: [process.cwd()] });
    const skills = await request("skills/list", {
      cwds: [process.cwd()],
      forceReload: true,
    });
    const mcp = await request("mcpServerStatus/list", {});
    results.push({
      enabled,
      hooks: (hooks.result?.data ?? []).map((value) => ({
        cwd: value.cwd,
        hooks: value.hooks?.filter(
          (item) => item.pluginId === "codex-lsp@codex-lsp-local",
        ),
      })),
      skills: (skills.result?.data ?? []).map((value) => ({
        cwd: value.cwd,
        skills: value.skills?.filter(
          (item) => item.pluginId === "codex-lsp@codex-lsp-local",
        ),
      })),
      mcp: (mcp.result?.data ?? [])
        .filter((value) => value.name === "codex-lsp")
        .map((value) => ({
          name: value.name,
          pluginId: value.pluginId,
          serverInfo: value.serverInfo,
          tools: Object.keys(value.tools ?? {}),
        })),
    });
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;
    clearTimeout(deadline);
    clearTimeout(hard);
  }
}
await fs.writeFile(
  join(output, "host-discovery.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    results.map((value) => ({
      enabled: value.enabled,
      mcpCount: value.mcp.length,
    })),
  ),
);
