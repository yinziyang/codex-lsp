import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { execute } from "./platform.ts";
import { installedCommand } from "./management.ts";

// codex-lsp-managed-command：安装器仅替换包含此标记的自有命令。
// 每次从宿主插件列表解析当前缓存并验证构建摘要，避免升级后继续调用旧版本。
const lifetime = new AbortController();
let child: ReturnType<typeof spawn> | undefined;
const stop = (signal: NodeJS.Signals) => {
  lifetime.abort(new Error("收到终止信号。"));
  if (child && child.exitCode === null) child.kill(signal);
};
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const result = await execute(
    "codex",
    ["plugin", "list", "--json", "--marketplace", "codex-lsp-local"],
    lifetime.signal,
    { timeout: 10000 },
  );
  const cli = installedCommand(JSON.parse(result.stdout), home);
  const bytes = await fs.readFile(cli, { signal: lifetime.signal });
  const info = JSON.parse(
    await fs.readFile(join(cli, "../build-info.json"), {
      encoding: "utf8",
      signal: lifetime.signal,
    }),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== info.buildHash)
    throw new Error("Broken：插件 CLI 构建摘要不匹配，请重新安装插件。");
  lifetime.signal.throwIfAborted();
  child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [join(process.execPath, ".."), process.env.PATH ?? ""].join(
        process.platform === "win32" ? ";" : ":",
      ),
    },
  });
  const shutdown = () => {
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
    }, 10000);
    timer.unref();
    child?.once("close", () => clearTimeout(timer));
  };
  lifetime.signal.addEventListener("abort", shutdown, { once: true });
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) =>
        resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
      );
    });
  } finally {
    lifetime.signal.removeEventListener("abort", shutdown);
  }
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
