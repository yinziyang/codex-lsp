import { spawnServer, forceTerminate } from "../extensions/pi-lsp/process.ts";
import { promises as fs, constants, watch, type FSWatcher } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 取消及故障均由调用方接收，库不自行退出进程。 */
export function check(signal: AbortSignal): void {
  signal.throwIfAborted();
}
/** 使用取消信号等待，毫秒参数必须有上界。 */
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** 执行参数数组，禁用 Shell，收集结果并响应取消。 */
export async function execute(
  command: string,
  args: string[],
  signal: AbortSignal,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  check(signal);
  const budget = AbortSignal.any([
    signal,
    AbortSignal.timeout(options.timeout ?? 60000),
  ]);
  const child = spawnServer(
    command,
    args,
    options.cwd ?? process.cwd(),
    options.env ?? process.env,
  );
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  let failure: unknown;
  let termination: Promise<void> | undefined;
  const terminate = (reason: unknown) => {
    failure ??= reason;
    termination ??= forceTerminate(child, 1000).catch((error) => {
      failure = error;
    });
  };
  const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
    if (kind === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2_000_000)
      terminate(new Error("命令输出超过2MB上限。"));
  };
  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));
  const abort = () => terminate(budget.reason);
  budget.addEventListener("abort", abort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (termination) await termination;
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(
        `${basename(command)} 执行失败，退出码 ${code}：${stderr.slice(-2000)}`,
      );
    return { stdout, stderr };
  } finally {
    budget.removeEventListener("abort", abort);
  }
}
/** 平台持久根只读取所需环境变量，默认不保存秘密。 */
export function dataRoot(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (env.CODEX_LSP_DATA_HOME) {
    if (!isAbsolute(env.CODEX_LSP_DATA_HOME))
      throw new Error("CODEX_LSP_DATA_HOME 必须为绝对路径。");
    return env.CODEX_LSP_DATA_HOME;
  }
  if (platform === "darwin")
    return join(homedir(), "Library", "Application Support", "codex-lsp");
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("缺少 LOCALAPPDATA。");
    return join(env.LOCALAPPDATA, "codex-lsp");
  }
  return join(
    env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "codex-lsp",
  );
}
/** 将相对工作区路径规范为真实目录，拒绝工作区外路径及符号链接。 */
export async function workspacePath(
  root: string,
  file: string | undefined,
  signal: AbortSignal,
): Promise<{ root: string; file?: string }> {
  check(signal);
  if (!isAbsolute(root))
    throw new Error("InvalidInput：workspaceRoot 必须为绝对路径。");
  const real = await fs.realpath(root);
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new Error("InvalidInput：工作区不是目录。");
  if (file === undefined) return { root: real };
  const target = resolve(real, file);
  const rel = relative(real, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("PermissionDenied：路径超出工作区。");
  let current = real;
  for (const segment of rel.split(/[\\/]/)) {
    current = join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw new Error("PermissionDenied：不分析符号链接。");
  }
  const actual = await fs.realpath(target);
  if (relative(real, actual).startsWith(".."))
    throw new Error("PermissionDenied：真实路径超出工作区。");
  check(signal);
  return { root: real, file: actual };
}
/** 原子写入失败不覆盖旧文件，权限仅限当前用户。 */
export async function atomicJson(
  path: string,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  check(signal);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    check(signal);
    await fs.rename(temp, path);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
/** 解析 PATH 大小写及 PATHEXT，内置脚本随后须解析到真实 JS 入口。 */
export async function findCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  signal: AbortSignal,
  extra: string[] = [],
): Promise<string | undefined> {
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const paths = isAbsolute(command)
    ? [""]
    : extra.concat(
        (env[pathKey ?? "PATH"] ?? "").split(
          platform === "win32" ? ";" : delimiter,
        ),
      );
  const suffixes =
    platform === "win32" && !extname(command)
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const directory of paths)
    for (const suffix of suffixes) {
      check(signal);
      const file = isAbsolute(command)
        ? command
        : join(directory, command + suffix.toLowerCase());
      try {
        await fs.access(
          file,
          platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        if ((await fs.stat(file)).isFile()) return file;
      } catch {}
    }
  return undefined;
}
/** 从 npm bin 映射寻找实际 JS 入口，Windows 不执行 cmd shim。 */
export async function nodeEntry(
  command: string,
  signal: AbortSignal,
): Promise<string> {
  check(signal);
  let actual = await fs.realpath(command);

  if (/\.cmd$|\.bat$/i.test(actual)) {
    const shim = await fs.readFile(actual, "utf8");
    const match =
      shim.match(/%dp0%[\\/]([^"\r\n]+\.[cm]?js)/i) ??
      shim.match(/%~dp0[\\/]([^"\r\n]+\.[cm]?js)/i);
    if (!match)
      throw new Error("Broken：自定义 cmd/bat 必须配置真实解释器和脚本入口。");
    actual = resolve(dirname(actual), match[1]);
  }
  const st = await fs.stat(actual);
  if (!st.isFile() || st.size > 2_000_000)
    throw new Error("Broken：脚本入口不合法。");
  let directory = dirname(actual);
  for (let depth = 0; depth < 8; depth++) {
    check(signal);
    try {
      const pkg = JSON.parse(
        await fs.readFile(join(directory, "package.json"), "utf8"),
      );
      const bins =
        typeof pkg.bin === "string"
          ? [pkg.bin]
          : pkg.bin && typeof pkg.bin === "object"
            ? Object.values(pkg.bin)
            : [];
      if (typeof pkg.name === "string" && typeof pkg.version === "string")
        for (const value of bins) {
          if (typeof value !== "string") continue;
          try {
            if ((await fs.realpath(resolve(directory, value))) === actual)
              return actual;
          } catch {}
        }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Broken：无法从已验证 npm 包的 bin 映射确认 JS 入口。");
}
export interface DiskFile {
  file: string;
  text: string;
  hash: string;
  size: number;
}
/** 内容摘要扫描不会仅靠 mtime/size，扫描不完整时显式报告原因。 */
export async function scan(
  root: string,
  extensions: Set<string>,
  signal: AbortSignal,
  maxFiles = 5000,
): Promise<{
  files: Map<string, DiskFile>;
  complete: boolean;
  warnings: string[];
}> {
  const stack = [root];
  const files = new Map<string, DiskFile>();
  const warnings: string[] = [];
  let seen = 0;
  let complete = true;
  const skipped = new Set([
    ".git",
    ".codex",
    "node_modules",
    "target",
    "vendor",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
  ]);
  while (stack.length) {
    check(signal);
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      warnings.push("目录无法读取：" + dir);
      complete = false;
      continue;
    }
    for (const entry of entries) {
      check(signal);
      if (++seen > maxFiles) {
        complete = false;
        warnings.push("扫描条目达到上限，后续批次继续。");
        stack.length = 0;
        break;
      }
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push("跳过符号链接：" + file);
        continue;
      }
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) stack.push(file);
        continue;
      }
      if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase()))
        continue;
      try {
        const st = await fs.stat(file);
        if (st.size > 2_000_000) {
          warnings.push("跳过超过2MB文件：" + file);
          continue;
        }
        const bytes = await fs.readFile(file, { signal });
        if (bytes.includes(0)) {
          warnings.push("跳过二进制：" + file);
          continue;
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        files.set(file, {
          file,
          text,
          size: st.size,
          hash: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        warnings.push("文件无法分析：" + file);
        complete = false;
      }
    }
  }
  return { files, complete, warnings };
}
/** 文件监听只记录脏状态，Hook 内容扫描负责补偿遗漏与溢出。 */
export class WorkspaceWatch {
  private watcher: FSWatcher | undefined;
  private root: string;
  private recursive: boolean;
  private closed = false;
  dirty = true;
  error: string | undefined;
  constructor(root: string, recursive = true) {
    this.root = root;
    this.recursive = recursive;
    this.listen();
  }
  /** 仅已识别的项目启用递归监听，容器目录只监听顶层，关闭后不得重新打开。 */
  setRecursive(enabled: boolean): void {
    if (this.closed || enabled === this.recursive) return;
    this.watcher?.close();
    this.watcher = undefined;
    this.recursive = enabled;
    this.listen();
  }
  private listen(): void {
    try {
      this.watcher = watch(this.root, { recursive: this.recursive }, () => {
        this.dirty = true;
      });
      this.watcher.on("error", (error) => {
        this.error = error.message;
        this.dirty = true;
      });
      this.watcher.unref();
    } catch (error) {
      this.error = String(error);
    }
  }
  /** 关闭幂等，不遗留监听句柄。 */
  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
  }
}
/** file URI 委托平台标准库，保留盘符和 UNC 语义。 */
export const uri = (file: string): string => pathToFileURL(file).href;
/** 非文件 URI 不允许作为项目文件。 */
export const pathOf = (value: string): string => fileURLToPath(value);
