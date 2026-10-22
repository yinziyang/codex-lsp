import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  formatResult,
  OPERATIONS,
  type Operation,
} from "../extensions/pi-lsp/format.ts";
import { workspacePath, uri, type DiskFile } from "./platform.ts";
import type { Instance, Workspace } from "./state.ts";
import { aggregateSymbols } from "./workspace-symbols.ts";
interface CallItem {
  thread: string;
  workspace: string;
  instance: string;
  generation: number;
  item: unknown;
  bytes: number;
}
interface Query {
  operation: Operation;
  workspaceRoot: string;
  filePath: string;
  line: number;
  character: number;
  query?: string;
  limit: number;
  callHierarchyItemId?: string;
}
const methods: Record<Operation, string> = {
  goToDefinition: "textDocument/definition",
  findReferences: "textDocument/references",
  hover: "textDocument/hover",
  documentSymbol: "textDocument/documentSymbol",
  workspaceSymbol: "workspace/symbol",
  goToImplementation: "textDocument/implementation",
  prepareCallHierarchy: "textDocument/prepareCallHierarchy",
  incomingCalls: "callHierarchy/incomingCalls",
  outgoingCalls: "callHierarchy/outgoingCalls",
};
const providers: Record<Operation, string> = {
  goToDefinition: "definitionProvider",
  findReferences: "referencesProvider",
  hover: "hoverProvider",
  documentSymbol: "documentSymbolProvider",
  workspaceSymbol: "workspaceSymbolProvider",
  goToImplementation: "implementationProvider",
  prepareCallHierarchy: "callHierarchyProvider",
  incomingCalls: "callHierarchyProvider",
  outgoingCalls: "callHierarchyProvider",
};
/** 查询依赖隔离真实协议与文件同步，以覆盖能力失败和候选失效。 */
export interface SemanticPorts {
  workspace: (root: string, signal: AbortSignal) => Promise<Workspace>;
  instance: (
    w: Workspace,
    file: string,
    signal: AbortSignal,
  ) => Promise<Instance | undefined>;
  sync: (i: Instance, file: DiskFile, signal: AbortSignal) => Promise<void>;
  identity: () => string;
  now: () => number;
  trace?: (event: unknown) => void;
}
/** 参数在任何外部调用前完成校验，UTF-16 坐标随后按文件验证。 */
function parseQuery(input: Record<string, unknown>): Query {
  if (
    !OPERATIONS.includes(input.operation as Operation) ||
    typeof input.workspaceRoot !== "string" ||
    typeof input.filePath !== "string"
  )
    throw new Error(
      "InvalidInput：operation、workspaceRoot 或 filePath 不合法。",
    );
  if (
    !Number.isInteger(input.line) ||
    Number(input.line) < 1 ||
    !Number.isInteger(input.character) ||
    Number(input.character) < 1
  )
    throw new Error("InvalidInput：行列必须为正整数。");
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 1000)
    throw new Error("InvalidInput：limit 必须为1至1000。");
  for (const field of ["query", "callHierarchyItemId"])
    if (input[field] !== undefined && typeof input[field] !== "string")
      throw new Error("InvalidInput：" + field + " 必须为字符串。");
  if (typeof input.query === "string" && Buffer.byteLength(input.query) > 4096)
    throw new Error("InvalidInput：query不能超过4096个UTF-8字节。");
  return {
    operation: input.operation as Operation,
    workspaceRoot: input.workspaceRoot,
    filePath: input.filePath,
    line: Number(input.line),
    character: Number(input.character),
    limit: Number(limit),
    query: input.query as string | undefined,
    callHierarchyItemId: input.callHierarchyItemId as string | undefined,
  };
}
const summary = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  return {
    name: item.name,
    kind: item.kind,
    uri: item.uri,
    range: item.range,
    selectionRange: item.selectionRange,
  };
};
function compactText(
  text: string,
  maximum: number,
): { text: string; truncated: boolean } {
  const points: string[] = [];
  for (const point of text) {
    if (points.length === maximum)
      return {
        text: points.slice(0, maximum - 1).join("") + "…",
        truncated: true,
      };
    points.push(point);
  }
  return { text: points.join(""), truncated: false };
}
/** 紧凑首响应只复制固定契约字段，最多三条百码点真实警告，并校验最终JSON的32000字节上界。 */
export function compactSemanticResult(
  value: Record<string, unknown>,
  responseId?: string,
): Record<string, unknown> {
  const original = Array.isArray(value.warnings)
    ? value.warnings.filter(
        (warning): warning is string => typeof warning === "string",
      )
    : [];
  const warnings = original
    .slice(0, 3)
    .map((warning) => compactText(warning, 100));
  const compact = {
    status: value.status,
    operation: value.operation,
    generation: value.generation,
    omitted: value.omitted,
    truncated: true,
    complete: false,
    ...(value.source
      ? { source: value.source, scannedFiles: value.scannedFiles }
      : {}),
    warnings: warnings.map((warning) => warning.text),
    warningsOmitted: original.length - warnings.length,
    warningsTruncated: warnings.filter((warning) => warning.truncated).length,
    text: compactText(String(value.text ?? ""), 2000).text,
    responseId,
    detail: responseId
      ? "使用 lsp_detail 分页获取完整结果。"
      : "原始结果超过4MB详情缓存上限，请缩小 query 或 limit。",
  };
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") > 32000)
    throw new Error(
      "ResourceLimit：紧凑响应元数据超过32000字节，不能返回超预算首响应。",
    );
  return compact;
}
/** 管理语义请求、格式转换及有界候选与详情缓存。 */
export class SemanticQueries {
  private ports: SemanticPorts;
  private items = new Map<string, CallItem>();
  private details = new Map<
    string,
    { thread: string; instance: Instance; generation: number; text: string }
  >();
  constructor(ports: SemanticPorts) {
    this.ports = ports;
  }
  private async document(
    input: Query,
    signal: AbortSignal,
  ): Promise<{ w: Workspace; file: DiskFile }> {
    const paths = await workspacePath(
      input.workspaceRoot,
      input.filePath,
      signal,
    );
    const w = await this.ports.workspace(paths.root, signal);
    const path = paths.file!;
    const bytes = await fs.readFile(path, { signal });
    if (bytes.length > 2_000_000)
      throw new Error("InvalidInput：文件超过2MB。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const line = text.split("\n")[input.line - 1];
    if (
      line === undefined ||
      input.character > line.replace(/\r$/, "").length + 1
    )
      throw new Error("InvalidInput：行列超出 UTF-16 文件范围。");
    return {
      w,
      file: {
        file: path,
        text,
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }
  private supported(i: Instance, operation: Operation): boolean {
    return (
      !!(i.client.capabilities as Record<string, unknown>)[
        providers[operation]
      ] ||
      i.client.registrations.has(methods[operation]) ||
      (providers[operation] === "callHierarchyProvider" &&
        i.client.registrations.has("textDocument/prepareCallHierarchy"))
    );
  }
  private remember(
    thread: string,
    w: Workspace,
    i: Instance,
    item: unknown,
  ): string {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (bytes > 256000)
      throw new Error(
        "ResourceLimit：调用项不透明数据超过256KB，不能安全缓存。",
      );
    const id = this.ports.identity();
    this.items.set(id, {
      thread,
      workspace: w.root,
      instance: i.key,
      generation: i.generation,
      item,
      bytes,
    });
    while (
      this.items.size > 512 ||
      [...this.items.values()].reduce((sum, item) => sum + item.bytes, 0) >
        4_000_000
    )
      this.items.delete(this.items.keys().next().value!);
    return id;
  }
  private async selection(
    thread: string,
    w: Workspace,
    i: Instance,
    input: Query,
    position: unknown,
    signal: AbortSignal,
  ): Promise<{
    status?: "StaleItem" | "Empty";
    item?: unknown;
    count?: number;
  }> {
    if (input.callHierarchyItemId) {
      const item = this.items.get(input.callHierarchyItemId);
      if (
        !item ||
        item.thread !== thread ||
        item.workspace !== w.root ||
        item.instance !== i.key ||
        item.generation !== i.generation
      )
        return { status: "StaleItem" };
      return { item: item.item };
    }
    const candidates = await i.client.request<unknown[]>(
      "textDocument/prepareCallHierarchy",
      { textDocument: { uri: uri(input.filePath) }, position },
      signal,
    );
    if (!Array.isArray(candidates) || !candidates.length)
      return { status: "Empty", count: 0 };
    return { item: candidates[0], count: candidates.length };
  }
  private bounded(
    thread: string,
    i: Instance,
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) <= 32000) return value;
    let responseId: string | undefined;
    if (text.length <= 4_000_000) {
      responseId = this.ports.identity();
      this.details.set(responseId, {
        thread,
        instance: i,
        generation: i.generation,
        text,
      });
      while (
        this.details.size > 32 ||
        [...this.details.values()].reduce(
          (sum, item) => sum + item.text.length,
          0,
        ) > 4_000_000
      )
        this.details.delete(this.details.keys().next().value!);
    }
    return compactSemanticResult(value, responseId);
  }
  /** 分页详情按线程和实例代次隔离，偏移单位是 UTF-16 码元。 */
  detail(thread: string, id: string, offset: number): unknown {
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error("InvalidInput：详情偏移必须为非负整数。");
    const item = this.details.get(id);
    if (
      !item ||
      item.thread !== thread ||
      item.generation !== item.instance.generation
    )
      throw new Error("StaleItem：结果已过期或属于其他线程。");
    return {
      responseId: id,
      offset,
      text: item.text.slice(offset, offset + 2000),
      nextOffset: offset + 2000 < item.text.length ? offset + 2000 : undefined,
      totalLength: item.text.length,
    };
  }
  /** 九操作共享版本状态，能力缺失与空结果分开返回。 */
  async query(
    thread: string,
    raw: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const input = parseQuery(raw);
    const { w, file } = await this.document(input, signal);
    input.filePath = file.file;
    const i = await this.ports.instance(w, file.file, signal);
    if (!i) return { status: "Unsupported", reason: "无匹配服务器。" };
    const aggregate =
      input.operation === "workspaceSymbol" &&
      ["html", "css"].includes(i.server.name) &&
      !this.supported(i, input.operation) &&
      this.supported(i, "documentSymbol");
    if (!this.supported(i, input.operation) && !aggregate)
      return { status: "Unsupported", operation: input.operation };
    i.inflight++;
    try {
      const current = await fs.readFile(file.file, { signal });
      if (createHash("sha256").update(current).digest("hex") !== file.hash)
        return {
          status: "StaleItem",
          reason: "请求准备期间文件已变化，请重试。",
        };
      await this.ports.sync(i, file, signal);
      await i.client.whenReady(signal);
      const generation = i.generation;
      if (aggregate) {
        const combined = await aggregateSymbols(
          w,
          i,
          input.query ?? "",
          input.limit,
          signal,
          this.ports.sync,
          this.ports.trace,
        );
        if (generation !== i.generation) return { status: "StaleItem" };
        return this.bounded(thread, i, {
          status: combined.result.length ? "Supported" : "Empty",
          operation: input.operation,
          workspaceRoot: w.root,
          generation,
          text: formatResult(
            "workspaceSymbol",
            combined.result as never,
            w.root,
          ),
          ...combined,
        });
      }
      const position = { line: input.line - 1, character: input.character - 1 };
      const textDocument = { uri: uri(file.file) };
      let selected: unknown;
      let candidateCount: number | undefined;
      if (
        input.operation === "incomingCalls" ||
        input.operation === "outgoingCalls"
      ) {
        const candidate = await this.selection(
          thread,
          w,
          i,
          input,
          position,
          signal,
        );
        if (candidate.status)
          return { status: candidate.status, candidateCount: candidate.count };
        selected = candidate.item;
        candidateCount = candidate.count;
      }
      const params = selected
        ? { item: selected }
        : input.operation === "workspaceSymbol"
          ? { query: input.query ?? "" }
          : input.operation === "documentSymbol"
            ? { textDocument }
            : {
                textDocument,
                position,
                ...(input.operation === "findReferences"
                  ? { context: { includeDeclaration: true } }
                  : {}),
              };
      const rawResult = await i.client.request<unknown>(
        methods[input.operation],
        params,
        signal,
      );
      this.ports.trace?.({
        event: "semantic",
        instance: i.key,
        generation,
        operation: input.operation,
        params,
        result: rawResult,
      });
      if (generation !== i.generation) return { status: "StaleItem" };
      let result = rawResult;
      let omitted = 0;
      if (Array.isArray(rawResult)) {
        const unique = [
          ...new Map(
            rawResult.map((item) => [JSON.stringify(item), item]),
          ).values(),
        ];
        omitted = Math.max(0, unique.length - input.limit);
        result = unique.slice(0, input.limit);
      }
      const text = formatResult(input.operation, result as never, w.root);
      let callHierarchyItems: unknown[] | undefined;
      if (input.operation === "prepareCallHierarchy" && Array.isArray(result)) {
        callHierarchyItems = result.map((item) => ({
          callHierarchyItemId: this.remember(thread, w, i, item),
          item: summary(item),
        }));
        result = result.map(summary);
      }
      return this.bounded(thread, i, {
        status:
          result === null || (Array.isArray(result) && result.length === 0)
            ? "Empty"
            : "Supported",
        operation: input.operation,
        workspaceRoot: w.root,
        generation,
        text,
        result,
        omitted,
        callHierarchyItems,
        selectedCandidate: summary(selected),
        candidateCount,
      });
    } catch (error) {
      if (signal.aborted) return { status: "Cancelled" };
      if ((error as Error).name === "TimeoutError")
        return { status: "Timeout" };
      if (String(error).includes("StaleItem")) return { status: "StaleItem" };
      if ((error as { code?: number }).code === -32601)
        return { status: "Unsupported", reason: "服务端返回 MethodNotFound。" };
      if (String(error).includes("timed out")) return { status: "Timeout" };
      return { status: "ServerError", message: String(error).slice(0, 2000) };
    } finally {
      i.inflight--;
      i.lastActive = this.ports.now();
    }
  }
}
