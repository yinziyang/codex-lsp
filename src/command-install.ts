import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** 安装用户级稳定命令，固定当前合格 Node，不覆盖其他程序或修改 Shell 配置。 */
export async function installCommand(
  directory: string,
  source: string,
  node: string,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (platform === "win32")
    throw new Error(
      "Unsupported：Windows 请直接用 node <插件根>/dist/cli.js，用户级短命令当前支持 macOS/Linux。",
    );
  if (/[\r\n\s]/.test(node))
    throw new Error(
      "Unsupported：Node 路径包含空白，无法生成可靠的可执行脚本头。",
    );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, "codex-lsp");
  let existing = false;
  try {
    const st = await fs.lstat(destination);
    if (!st.isFile() || st.isSymbolicLink())
      throw new Error("Conflict：目标命令不是本插件文件。");
    const text = await fs.readFile(destination, { encoding: "utf8", signal });
    if (!text.includes("codex-lsp-managed-command"))
      throw new Error("Conflict：拒绝覆盖已有同名命令。");
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = await fs.readFile(source, { encoding: "utf8", signal });
  const text = `#!${node}\n// codex-lsp-managed-command\n` + bytes;
  if (!existing) {
    await fs.writeFile(destination, text, { mode: 0o700, flag: "wx", signal });
  } else {
    const temporary = destination + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, text, { mode: 0o700, flag: "wx", signal });
      signal.throwIfAborted();
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return destination;
}
