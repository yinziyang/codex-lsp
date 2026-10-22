import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { check, WorkspaceWatch, type DiskFile } from "./platform.ts";

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
    this.watch = new WorkspaceWatch(root);
  }
  private async *walk(): AsyncGenerator<ScanEvent> {
    const directories = [this.root];
    let entriesSeen = 0;
    while (directories.length) {
      check(this.signal);
      const directory = directories.pop()!;
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        yield { warning: "目录读取失败：" + directory, incomplete: true };
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
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) directories.push(file);
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
          const stat = await fs.stat(file);
          if (stat.size > 2_000_000) {
            yield { warning: "跳过超过2MB文件：" + file };
            continue;
          }
          const bytes = await fs.readFile(file, { signal: this.signal });
          if (bytes.includes(0)) {
            yield { warning: "跳过二进制：" + file };
            continue;
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          yield {
            file: {
              file,
              text,
              size: stat.size,
              hash: createHash("sha256").update(bytes).digest("hex"),
            },
          };
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
