import { promises as fs, constants } from "node:fs";
import { extname, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import ignore, { type Ignore } from "ignore";
import type { Instance, Workspace } from "./state.ts";
import { check, uri, type DiskFile } from "./platform.ts";
import { ignoredDirectories } from "./workspace.ts";

/** 兼容聚合的固定资源预算，不是服务器原生workspaceSymbol能力。 */
export const symbolBudget = {
  entries: 10000,
  files: 128,
  bytes: 16000000,
  fileBytes: 2000000,
  symbols: 10000,
  depth: 32,
} as const;
interface Rule {
  root: string;
  filter: Ignore;
}
interface Scan {
  files: string[];
  complete: boolean;
  reasons: string[];
  entries: number;
}
const inside = (root: string, path: string) => {
  const name = relative(root, path);
  return (
    !isAbsolute(name) &&
    name !== ".." &&
    !name.startsWith("../") &&
    !name.startsWith("..\\")
  );
};
/** 打开后复核真实路径和文件身份再读取，拒绝扫描后被替换的链接，句柄始终有界释放。 */
export async function readSymbolFile(
  root: string,
  path: string,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  check(signal);
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    maximum > symbolBudget.fileBytes
  )
    throw new Error("InvalidInput：文件读取预算无效。");
  if (!inside(root, path) || (await fs.realpath(path)) !== path)
    throw new Error("文件真实路径越界或改变。");
  // 非阻塞打开使扫描后换成FIFO的输入也能立即进入普通文件身份检查。
  const handle = await fs.open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    const real = await fs.realpath(path);
    const current = await fs.lstat(path);
    if (
      real !== path ||
      current.isSymbolicLink() ||
      !opened.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error("文件在打开期间被替换或真实路径越界。");
    if (opened.size > maximum) throw new Error("文件超过读取预算。");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      check(signal);
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("读取时文件超过预算。");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function rules(
  root: string,
  inherited: Rule[],
  signal: AbortSignal,
): Promise<Rule[]> {
  const path = join(root, ".gitignore");
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink())
      throw new Error("跳过符号链接gitignore，无法确认完整忽略规则。");
    if (stat.size > 128000) throw new Error("gitignore超过128KB预算。");
    const bytes = await readSymbolFile(root, path, 128000, signal);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return [...inherited, { root, filter: ignore().add(text) }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return inherited;
    throw error;
  }
}
function ignored(path: string, directory: boolean, filters: Rule[]): boolean {
  let answer = false;
  for (const rule of filters) {
    const name =
      relative(rule.root, path).replaceAll("\\", "/") + (directory ? "/" : "");
    const result = rule.filter.test(name);
    if (result.ignored) answer = true;
    else if (result.unignored) answer = false;
  }
  return answer;
}
/** 使用流式目录遍历与逐层gitignore，不跟随链接，不读取其他项目根。 */
async function scan(
  w: Workspace,
  i: Instance,
  signal: AbortSignal,
): Promise<Scan> {
  const result: Scan = { files: [], complete: true, reasons: [], entries: 0 };
  const pending = [{ root: i.root, filters: [] as Rule[], depth: 0 }];
  while (pending.length) {
    check(signal);
    const current = pending.pop()!;
    if (
      !inside(w.root, current.root) ||
      (await fs.realpath(current.root)) !== current.root
    )
      throw new Error("InvalidInput：聚合项目根真实路径越界或改变。");
    try {
      const filters = await rules(current.root, current.filters, signal);
      const directory = await fs.opendir(current.root);
      for await (const entry of directory) {
        check(signal);
        if (++result.entries > symbolBudget.entries) {
          result.complete = false;
          result.reasons.push("目录条目达到10000上限。");
          return result;
        }
        const file = join(current.root, entry.name);
        if (
          entry.isSymbolicLink() ||
          ignoredDirectories.has(entry.name) ||
          ignored(file, entry.isDirectory(), filters)
        )
          continue;
        if (entry.isDirectory()) {
          if (current.depth >= symbolBudget.depth) {
            result.complete = false;
            result.reasons.push("目录深度超过32层。");
          } else
            pending.push({ root: file, filters, depth: current.depth + 1 });
        } else if (
          entry.isFile() &&
          i.server.extensionToLanguage[extname(file).toLowerCase()]
        ) {
          const routedRoot = w.router.rootFor(i.server, file);
          const routed = inside(w.root, routedRoot) ? routedRoot : w.root;
          if ((await fs.realpath(routed)) !== i.root) continue;
          if (result.files.length >= symbolBudget.files) {
            result.complete = false;
            result.reasons.push("候选文件达到128个上限。");
            return result;
          }
          result.files.push(file);
        }
      }
    } catch (error) {
      check(signal);
      result.complete = false;
      result.reasons.push(String(error).slice(0, 300));
    }
  }
  result.files.sort();
  return result;
}
/** DocumentSymbol和SymbolInformation都转换为真实文档位置，不推断文本语义。 */
function symbols(
  raw: unknown,
  documentUri: string,
  query: string,
): { values: unknown[]; complete: boolean } {
  if (raw === null) return { values: [], complete: true };
  if (!Array.isArray(raw))
    throw new Error("ProtocolError：documentSymbol响应必须为数组或null。");
  const pending = raw.slice(0, symbolBudget.symbols).reverse();
  let complete = raw.length <= symbolBudget.symbols;
  const values: unknown[] = [];
  let count = 0;
  while (pending.length) {
    if (++count > symbolBudget.symbols) return { values, complete: false };
    const item = pending.pop();
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.name !== "string" ||
      Buffer.byteLength(item.name) > 4096 ||
      !Number.isInteger(item.kind) ||
      item.kind < 1 ||
      item.kind > 26
    )
      throw new Error("ProtocolError：文档符号缺少名称或类型。");
    const range = item.location?.range ?? item.range;
    for (const position of [range?.start, range?.end])
      if (
        !position ||
        !Number.isInteger(position.line) ||
        position.line < 0 ||
        !Number.isInteger(position.character) ||
        position.character < 0
      )
        throw new Error("ProtocolError：文档符号范围无效。");
    if (
      range.end.line < range.start.line ||
      (range.end.line === range.start.line &&
        range.end.character < range.start.character)
    )
      throw new Error("ProtocolError：文档符号结束位置早于开始位置。");
    if (item.location && item.location.uri !== documentUri)
      throw new Error("ProtocolError：文档符号返回其他文档URI。");
    if (item.name.toLowerCase().includes(query))
      values.push({
        name: item.name,
        kind: item.kind,
        location: { uri: documentUri, range },
        ...(typeof item.containerName === "string"
          ? { containerName: item.containerName }
          : {}),
      });
    if (item.children !== undefined) {
      if (!Array.isArray(item.children))
        throw new Error("ProtocolError：children必须为数组。");
      const room = Math.max(0, symbolBudget.symbols - count - pending.length);
      if (item.children.length > room) complete = false;
      pending.push(...item.children.slice(0, room).reverse());
    }
  }
  return { values, complete };
}
/** 单文档协议事务同时校验文件内容、Core版本和实例代次，不重置已有文档。 */
async function documentSymbols(
  i: Instance,
  path: string,
  available: number,
  query: string,
  generation: number,
  signal: AbortSignal,
  sync: (i: Instance, file: DiskFile, signal: AbortSignal) => Promise<void>,
  trace?: (event: unknown) => void,
) {
  const bytes = await readSymbolFile(
    i.root,
    path,
    Math.min(symbolBudget.fileBytes, available),
    signal,
  );
  available -= bytes.length;
  const file = {
    file: path,
    size: bytes.length,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
  await sync(i, file, signal);
  const version = i.docs.get(path)?.version;
  const params = { textDocument: { uri: uri(path) } };
  const raw = await i.client.request<unknown>(
    "textDocument/documentSymbol",
    params,
    signal,
  );
  trace?.({
    event: "workspace-symbol-document",
    instance: i.key,
    generation,
    version,
    params,
    result: raw,
  });
  if (i.generation !== generation || i.docs.get(path)?.version !== version)
    throw new Error("StaleItem：聚合期间文档或实例代次改变。");
  const verified = await readSymbolFile(
    i.root,
    path,
    Math.min(symbolBudget.fileBytes, available),
    signal,
  );

  if (createHash("sha256").update(verified).digest("hex") !== file.hash)
    throw new Error("StaleItem：聚合期间文件已改变。");
  return {
    ...symbols(raw, uri(path), query.toLowerCase()),
    bytes: bytes.length + verified.length,
  };
}
/** 聚合当前实例项目根内的真实documentSymbol，沿用Core文档同步和代次，不另建会话或版本。 */
export async function aggregateSymbols(
  w: Workspace,
  i: Instance,
  query: string,
  limit: number,
  signal: AbortSignal,
  sync: (i: Instance, file: DiskFile, signal: AbortSignal) => Promise<void>,
  trace?: (event: unknown) => void,
): Promise<{
  result: unknown[];
  source: string;
  complete: boolean;
  scopeRoot: string;
  scannedFiles: number;
  omitted: number;
  warnings: string[];
  query: string;
}> {
  const budget = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const scanResult = await scan(w, i, budget);
  const values: unknown[] = [];
  let bytesSeen = 0,
    scannedFiles = 0;
  let resultBytes = 0;
  const generation = i.generation;
  for (const path of scanResult.files) {
    check(budget);
    try {
      if ((await fs.realpath(path)) !== path || !inside(i.root, path))
        throw new Error("文件真实路径改变或越界。");
      if (bytesSeen >= symbolBudget.bytes) {
        scanResult.complete = false;
        scanResult.reasons.push("总文件内容超过16MB预算。");
        break;
      }
      const converted = await documentSymbols(
        i,
        path,
        symbolBudget.bytes - bytesSeen,
        query,
        generation,
        budget,
        sync,
        trace,
      );
      bytesSeen += converted.bytes;
      let exhausted = false;
      for (const value of converted.values) {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (
          values.length >= symbolBudget.symbols ||
          resultBytes + size > 2000000
        ) {
          exhausted = true;
          break;
        }
        resultBytes += size;
        values.push(value);
      }
      scannedFiles++;
      if (!converted.complete || exhausted) {
        scanResult.complete = false;
        scanResult.reasons.push("文档符号达到10000项或结果2MB预算。");
        break;
      }
    } catch (error) {
      check(budget);
      if (String(error).includes("StaleItem")) throw error;
      scanResult.complete = false;
      scanResult.reasons.push(String(error).slice(0, 300));
      break;
    }
  }
  const unique = [
    ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
  ];
  const omitted = Math.max(0, unique.length - limit);
  return {
    result: unique.slice(0, limit),
    source: "documentSymbol-aggregation",
    scopeRoot: i.root,
    complete: scanResult.complete && omitted === 0,
    scannedFiles,
    omitted,
    warnings: [...new Set(scanResult.reasons)].slice(0, 20),
    query,
  };
}
