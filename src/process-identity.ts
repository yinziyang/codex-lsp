import { nativePowerShellEnvironment } from "../extensions/pi-lsp/process.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
/** PID 只用于查询，创建身份用于区分复用后的无关进程，不输出命令参数。 */
export async function inspectProcess(
  pid: number,
  signal: AbortSignal,
): Promise<{ state: "alive" | "gone" | "unknown"; identity?: string }> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unknown" };
  try {
    process.kill(pid, 0);
  } catch (error) {
    return {
      state:
        (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown",
    };
  }
  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.StartTime.ToUniversalTime().Ticks) $($p.ProcessName)"`,
        ]
      : ["-p", String(pid), "-o", "lstart=,comm="];
  try {
    const value = await new Promise<string>((resolve, reject) =>
      execFile(
        command,
        args,
        {
          signal,
          timeout: 2000,
          windowsHide: true,
          encoding: "utf8",
          env: {
            ...(process.platform === "win32"
              ? nativePowerShellEnvironment(process.env)
              : process.env),
            LC_ALL: "C",
          },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      ),
    );
    if (!value) return { state: "unknown" };
    return {
      state: "alive",
      identity: createHash("sha256").update(value).digest("hex"),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    try {
      process.kill(pid, 0);
      return { state: "unknown" };
    } catch {
      return { state: "gone" };
    }
  }
}
