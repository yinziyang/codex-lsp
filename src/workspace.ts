import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { check, WorkspaceWatch, type DiskFile } from "./platform.ts";
import {
  ignoreRules,
  inside,
  ignored,
  readScanFile,
  type IgnoreRule,
} from "./scan-policy.ts";

/** 工作区扫描固定排除的生成物与依赖目录，兼容聚合复用以免边界漂移。 */
export const ignoredDirectories: ReadonlySet<string> = new Set([
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
const extensions = new Set([
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  ".hh",
  ".go",
  ".rs",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".py",
  ".pyi",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
]);
interface ScanEvent {
  file?: DiskFile;
  warning?: string;
  incomplete?: boolean;
}
const projectMarkers = [
  ".git",
  "go.mod",
  "Cargo.toml",
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "setup.py",
  "compile_commands.json",
  ".clangd",
  "CMakeLists.txt",
];
/** 容器目录不自动扫描其中独立项目，实际项目内部仍包含monorepo子包。 */
async function projectDirectory(
  directory: string,
  signal: AbortSignal,
): Promise<boolean> {
  for (const marker of projectMarkers) {
    check(signal);
    try {
      await fs.lstat(join(directory, marker));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return (await fs.readdir(directory, { withFileTypes: true })).some(
    (entry) =>
      entry.isFile() && extensions.has(extname(entry.name).toLowerCase()),
  );
}
/** 工作区监听、分批内容扫描与快照拥有者，不包含 LSP 协议。 */
export class WorkspaceIndex {
  readonly watch: WorkspaceWatch;
  private iterator: AsyncGenerator<ScanEvent> | undefined;
  private files = new Map<string, DiskFile>();
  private warnings: string[] = [];
  private failed = false;
  private signal: AbortSignal = AbortSignal.abort();
  private root: string;
  constructor(root: string) {
    this.root = root;
    this.watch = new WorkspaceWatch(root, false);
  }
  /** 启动服务器后重新读取当前内容，避免等待期间的旧扫描快照回写并倒退文档版本。 */
  async current(file: string, signal: AbortSignal): Promise<DiskFile> {
    check(signal);
    const stat = await fs.lstat(file);
    if (stat.size > 2000000) throw new Error("文件超过2MB扫描预算。");
    const bytes = await readScanFile(this.root, file, stat.size, signal);
    if (bytes.includes(0))
      throw new Error("文件包含二进制内容，不能作为源码同步。");
    return {
      file,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      size: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  /** 仅查目录项是否存在，不读取被排除的源码，区分删除和移出扫描范围。 */
  async present(file: string, signal: AbortSignal): Promise<boolean> {
    check(signal);
    if (!inside(this.root, file))
      throw new Error("InvalidInput：文件路径越界。");
    try {
      await fs.lstat(file);
      check(signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async *walk(): AsyncGenerator<ScanEvent> {
    const project = await projectDirectory(this.root, this.signal);
    this.watch.setRecursive(project);
    if (!project) {
      yield {
        warning:
          "当前目录未识别为源码项目，不自动遍历其中的子项目，请以实际项目目录启动Codex。",
      };
      return;
    }
    const directories = [{ path: this.root, filters: [] as IgnoreRule[] }];
    let entriesSeen = 0;
    while (directories.length) {
      check(this.signal);
      const current = directories.pop()!;
      const directory = current.path;
      let filters: IgnoreRule[];
      let entries;
      try {
        filters = await ignoreRules(directory, current.filters, this.signal);
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (this.signal.aborted) throw error;
        yield {
          warning: "目录或忽略规则读取失败：" + directory,
          incomplete: true,
        };
        continue;
      }
      for (const entry of entries) {
        check(this.signal);
        const file = join(directory, entry.name);
        if (++entriesSeen > 1_000_000) {
          yield {
            warning: "扫描达到一百万条目硬上限，覆盖不完整。",
            incomplete: true,
          };
          return;
        }
        if (entry.isSymbolicLink()) {
          yield { warning: "跳过符号链接：" + file };
          continue;
        }
        if (ignored(file, entry.isDirectory(), filters)) continue;
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) {
            try {
              let repository = false;
              try {
                await fs.lstat(join(file, ".git"));
                repository = true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
              if (repository)
                yield {
                  warning: "跳过独立项目，请以该项目为工作区查询：" + file,
                };
              else directories.push({ path: file, filters });
            } catch (error) {
              if (this.signal.aborted) throw error;
              yield { warning: "项目边界无法确认：" + file, incomplete: true };
            }
          }
          yield {};
          continue;
        }
        if (
          !entry.isFile() ||
          !extensions.has(extname(entry.name).toLowerCase())
        ) {
          yield {};
          continue;
        }
        try {
          yield { file: await this.current(file, this.signal) };
        } catch (error) {
          if (this.signal.aborted) throw error;
          yield { warning: "文件读取失败：" + file, incomplete: true };
        }
      }
    }
  }
  /** 每批保留游标，后续批次不会反复只扫目录前缀，失败不能授权删除旧文件。 */
  async readBatch(
    signal: AbortSignal,
    limit = 1000,
  ): Promise<{
    files: Map<string, DiskFile>;
    complete: boolean;
    warnings: string[];
  }> {
    this.signal = signal;
    check(signal);
    if (!this.iterator) {
      this.files = new Map();
      this.warnings = [];
      this.failed = false;
      this.iterator = this.walk();
    }
    try {
      for (let index = 0; index < limit; index++) {
        check(signal);
        const next = await this.iterator.next();
        if (next.done) {
          this.iterator = undefined;
          this.watch.dirty = this.failed;
          return {
            files: new Map(this.files),
            complete: !this.failed,
            warnings: [...this.warnings],
          };
        }
        if (next.value.file)
          this.files.set(next.value.file.file, next.value.file);
        if (next.value.warning && this.warnings.length < 100)
          this.warnings.push(next.value.warning);
        this.failed ||= next.value.incomplete ?? false;
      }
    } catch (error) {
      this.iterator = undefined;
      this.watch.dirty = true;
      throw error;
    }
    this.watch.dirty = true;
    return {
      files: new Map(this.files),
      complete: false,
      warnings: [...this.warnings, "扫描分批进行，覆盖尚未完成。"],
    };
  }
  /** 幂等停止所有监听并丢弃游标。 */
  close(): void {
    this.watch.close();
    this.iterator = undefined;
  }
}
