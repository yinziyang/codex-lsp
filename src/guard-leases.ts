import { promises as fs } from "node:fs";
import { join } from "node:path";
import { inspectProcess } from "./process-identity.ts";
import { readJson, missing } from "./configuration.ts";
/** 私有LS守护租约在宿主强杀后继续存在，令牌不参与此只读记录。 */
export interface GuardLease {
  creator: "codex-lsp";
  guardId: string;
  coreId: string;
  server: string;
  guardPid: number;
  guardIdentity: string;
  childPid?: number;
  childIdentity?: string;
  workspace: string;
  state: "starting" | "running" | "residual";
}
/** 只读识别本插件记录，无法核实身份时保留未知而非猜测PID。 */
export async function guardLeases(
  root: string,
  signal: AbortSignal,
): Promise<{ lease: GuardLease; state: "active" | "gone" | "unknown" }[]> {
  const directory = join(root, "runtime", "guards");
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const result: { lease: GuardLease; state: "active" | "gone" | "unknown" }[] =
    [];
  for (const name of names) {
    signal.throwIfAborted();
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    const stat = await fs.lstat(join(directory, name));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      throw new Error("OwnershipError：守护租约权限不合法。");
    const lease = (await readJson(
      join(directory, name),
      null,
      signal,
    )) as GuardLease;
    if (
      !lease ||
      lease.creator !== "codex-lsp" ||
      lease.guardId + ".json" !== name ||
      typeof lease.server !== "string" ||
      !Number.isSafeInteger(lease.guardPid) ||
      typeof lease.guardIdentity !== "string"
    )
      throw new Error("Broken：守护租约损坏，不能证明资产空闲。");
    const guard = await inspectProcess(lease.guardPid, signal);
    if (guard.state === "alive" && guard.identity === lease.guardIdentity) {
      result.push({ lease, state: "active" });
      continue;
    }
    if (!lease.childPid || !lease.childIdentity) {
      result.push({ lease, state: "unknown" });
      continue;
    }
    const child = await inspectProcess(lease.childPid, signal);
    result.push({
      lease,
      state:
        child.state === "gone" ||
        (child.state === "alive" && child.identity !== lease.childIdentity)
          ? "gone"
          : child.state === "alive"
            ? "active"
            : "unknown",
    });
  }
  return result;
}
