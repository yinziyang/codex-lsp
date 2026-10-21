import { promises as fs } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnServer, forceTerminate } from "../extensions/pi-lsp/process.ts";
import { atomicJson } from "./platform.ts";
import { inspectProcess } from "./process-identity.ts";
import type { GuardLease } from "./guard-leases.ts";

/** 私有管道守护是独立进程入口，父MCP强杀时仍负责本LS的有界收尾。 */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = process.env.CODEX_LSP_GUARD_DATA;
  const coreId = process.env.CODEX_LSP_GUARD_CORE;
  const server = process.env.CODEX_LSP_GUARD_SERVER;
  if (
    !command ||
    !isAbsolute(command) ||
    !root ||
    !isAbsolute(root) ||
    !coreId ||
    !server
  )
    throw new Error("内部守护参数不合法。");
  const signal = AbortSignal.timeout(8000);
  const guardId = randomUUID();
  const own = await inspectProcess(process.pid, signal);
  if (!own.identity) throw new Error("无法核实守护进程身份。");
  const path = join(root, "runtime", "guards", guardId + ".json");
  const lease: GuardLease = {
    creator: "codex-lsp",
    guardId,
    coreId,
    server,
    guardPid: process.pid,
    guardIdentity: own.identity,
    workspace: process.cwd(),
    state: "starting",
  };
  await atomicJson(path, lease, signal);
  const child = spawnServer(command, args, process.cwd(), process.env);
  let childClosed = false;
  let cleanupError: unknown;
  let closing: Promise<void> | undefined;
  let hard: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      childClosed = true;
      resolve();
    }),
  );
  child.stdin.on("error", () => {});
  process.stdout.on("error", () => {
    child.stdout.unpipe(process.stdout);
    child.stdout.resume();
  });
  process.stderr.on("error", () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const waitClosed = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      closed.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  const frame = (message: unknown) => {
    if (child.stdin.destroyed) return;
    const body = JSON.stringify(message);
    child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  };
  const shutdown = () =>
    (closing ??= (async () => {
      hard = setTimeout(() => {
        process.stderr.write("LS守护退出超时，保留残留租约。\n");
        process.exit(1);
      }, 8000);
      process.stdin.unpipe(child.stdin);
      if (!childClosed) {
        frame({
          jsonrpc: "2.0",
          id: "codex-lsp-private-shutdown",
          method: "shutdown",
          params: null,
        });
        await waitClosed(750);
        if (!childClosed) {
          frame({ jsonrpc: "2.0", method: "exit" });
          child.stdin.end();
          await waitClosed(750);
        }
        if (!childClosed)
          try {
            await forceTerminate(child, 1000);
          } catch (error) {
            cleanupError = error;
          }
      }
    })());
  process.stdin.on("end", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("LS未提供PID。");
    const identity = await inspectProcess(child.pid, signal);
    if (!identity.identity) throw new Error("无法确认LS创建身份。");
    lease.childPid = child.pid;
    lease.childIdentity = identity.identity;
    lease.state = "running";
    await atomicJson(path, lease, signal);
    process.stdin.pipe(child.stdin);
    await closed;
    if (closing) await closing;
    if (cleanupError) throw cleanupError;
    await fs.rm(path, { force: true });
    process.exitCode = child.exitCode ?? 0;
  } catch (error) {
    lease.state = "residual";
    await atomicJson(path, lease, AbortSignal.timeout(2000)).catch(() => {});
    if (!childClosed) await forceTerminate(child, 1000).catch(() => {});
    throw error;
  } finally {
    if (hard) clearTimeout(hard);
    process.stdin.destroy();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
