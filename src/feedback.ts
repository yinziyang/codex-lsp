import { createHash } from "node:crypto";
import type { Diagnostic } from "./diagnostic-value.ts";
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
/** 超长路径只展示带稳定摘要的可见提示，原始URI保留在详情。 */
export function displayUri(uri: string): string {
  return escape(
    uri.length <= 500
      ? uri
      : uri.slice(0, 250) +
          "…" +
          uri.slice(-150) +
          " [路径摘要 " +
          createHash("sha256").update(uri).digest("hex").slice(0, 12) +
          "]",
  );
}
/** 模型可见输出预算拥有者，先包装完整项再决定送达类别。 */
export class FeedbackBatch {
  private lines: string[] = [];
  private files = new Map<string, number>();
  private count = 0;
  private batchId: string;
  constructor(eventId: string) {
    this.batchId = createHash("sha256")
      .update(eventId)
      .digest("hex")
      .slice(0, 24);
  }
  private fits(line: string): boolean {
    const body = [...this.lines, line].join("\n");
    return (
      body.length <= 3800 &&
      Buffer.byteLength(`诊断批次 ${this.batchId}\n${body}`) <= 7400
    );
  }
  /** 返回完整项、摘要或未展示，不把摘要记作完整诊断。 */
  diagnostic(value: {
    id: string;
    uri: string;
    diagnostic: Diagnostic;
    version: number;
    generation: number;
    baseline: boolean;
    trusted: boolean;
  }): "full" | "summary" | "omitted" {
    const { diagnostic: d } = value;
    if (this.count >= 30 || (this.files.get(value.uri) ?? 0) >= 10)
      return "omitted";
    const tag = value.baseline ? "new-diagnostics" : "current-diagnostics";
    const state =
      (value.baseline ? "相对基线新增" : "新增归因未知") +
      (value.trusted ? "" : "，版本不确定");
    let line = `<${tag}>id=${value.id} ${displayUri(value.uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} 级别=${d.severity ?? 1} 来源=${escape(d.source ?? "未知")} 代码=${escape(String(d.code ?? ""))} 版本=${value.version} 代次=${value.generation} ${state} ${escape(d.message)}</${tag}>`;
    let full = true;
    if (
      line.length > 3500 ||
      Buffer.byteLength(line) > 6500 ||
      value.uri.length > 500
    ) {
      line = `<${tag}>id=${value.id} ${displayUri(value.uri)} 版本=${value.version} ${state} ${escape(Array.from(d.message).slice(0, 120).join(""))} 正文省略，调用 diagnostics_detail 获取完整项，未记完整送达。</${tag}>`;
      full = false;
    }
    if (!this.fits(line)) return "omitted";
    this.lines.push(line);
    this.count++;
    this.files.set(value.uri, (this.files.get(value.uri) ?? 0) + 1);
    return full && value.trusted ? "full" : "summary";
  }
  /** 状态说明也进入预算，放不下时交回调用方保留游标。 */
  state(line: string): boolean {
    if (!this.fits(line)) return false;
    this.lines.push(line);
    return true;
  }
  /** 批次标识和剩余游标均计入最终UTF-8预算。 */
  finish(omitted: number, cursor?: string): string {
    if (this.lines.length === 0 && omitted === 0) return "";
    const footer = omitted
      ? `\n剩余 ${omitted} 项，游标=${cursor}，使用 diagnostics_remaining 获取下一批。`
      : "";
    const result = `诊断批次 ${this.batchId}\n${this.lines.join("\n")}${footer}`;
    if (Buffer.byteLength(result) > 8000)
      throw new Error("OutputBudget：未提交超限批次。");
    return result;
  }
}
