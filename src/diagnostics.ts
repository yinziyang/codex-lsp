import { createHash } from "node:crypto";

import { type Diagnostic } from "./diagnostic-value.ts";
import { FeedbackBatch, displayUri } from "./feedback.ts";
export { type Diagnostic, parseDiagnostics } from "./diagnostic-value.ts";

interface Channel {
  items: Diagnostic[];
  version: number;
  complete: boolean;
  resultId?: string;
}
interface FileState {
  workspace: string;
  uri: string;
  version: number;
  generation: number;
  deleted: boolean;
  excluded?: boolean;
  epoch: number;
  channels: Map<string, Channel>;
}
interface Thread {
  session: string;
  baseline: Map<string, Set<string>>;
  delivered: Set<string>;
  summaries: Set<string>;
  batches: Map<string, string>;
  details: Map<string, { uri: string; diagnostic: Diagnostic }>;
  pendingStates: Map<
    string,
    { workspace: string; uri: string; version: number; text: string }
  >;
  cursors: Map<string, string>;
  continued: Set<string>;
  pending: Set<string>;
}
const key = (d: Diagnostic) =>
  createHash("sha256")
    .update(JSON.stringify([d.message, d.severity, d.range, d.source, d.code]))
    .digest("hex");
const id = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);

/** 维护分析可信度、跨轮基线与幂等投递，过期结果永远不能合成为空结果。 */
export class DiagnosticLedger {
  private files = new Map<string, FileState>();
  private threads = new Map<string, Thread>();
  /** 注册当前文档代次并使旧通道过期，保留旧项及 resultId。 */
  edit(
    workspace: string,
    uri: string,
    version: number,
    generation: number,
    channels: string[],
  ): void {
    const old = this.files.get(workspace + "\0" + uri);
    const values = new Map<string, Channel>();
    for (const name of channels) {
      const previous = old?.channels.get(name);
      values.set(name, {
        items: previous?.items ?? [],
        version: previous?.version ?? 0,
        resultId: previous?.resultId,
        complete: false,
      });
    }
    this.files.set(workspace + "\0" + uri, {
      workspace,
      uri,
      version,
      generation,
      deleted: false,
      epoch: old ? old.epoch + (old.deleted || old.excluded ? 1 : 0) : 1,
      channels: values,
    });
  }
  /** 删除文件与代码修复分别记录。 */
  deleted(uri: string, workspace?: string): void {
    const file = workspace
      ? this.files.get(workspace + "\0" + uri)
      : [...this.files.values()].find((file) => file.uri === uri);
    if (file) {
      file.deleted = true;
      file.channels.clear();
    }
  }
  /** 移出自动扫描范围只结束跟踪，不冒充物理删除或诊断修复。 */
  exclude(uri: string, workspace: string): void {
    const file = this.files.get(workspace + "\0" + uri);
    if (file) {
      file.excluded = true;
      file.channels.clear();
    }
  }
  /** 接收同代次结果，无版本推送仅可作为不确定观察。 */
  receive(
    uri: string,
    channel: string,
    items: Diagnostic[],
    version: number | undefined,
    generation: number,
    resultId?: string,
    unchanged = false,
    workspace?: string,
  ): void {
    const f = workspace
      ? this.files.get(workspace + "\0" + uri)
      : [...this.files.values()].find((file) => file.uri === uri);
    if (
      !f ||
      f.deleted ||
      f.generation !== generation ||
      (version !== undefined && version !== f.version)
    )
      return;
    const old = f.channels.get(channel);
    if (unchanged && (!old?.resultId || old.resultId !== resultId)) return;
    f.channels.set(channel, {
      items: unchanged ? old!.items : items,
      version: version ?? f.version,
      complete: version !== undefined,
      resultId: resultId ?? old?.resultId,
    });
  }
  /** 是否仍有通道未完成，不以安静窗口冒充分析完成。 */
  pending(workspace: string): boolean {
    return [...this.files.values()].some(
      (file) =>
        file.workspace === workspace &&
        !file.deleted &&
        !file.excluded &&
        !this.trusted(file),
    );
  }

  /** 返回通道缓存，用于 Pull previousResultId。 */
  previous(
    uri: string,
    channel: string,
    workspace?: string,
  ): Channel | undefined {
    return (
      workspace
        ? this.files.get(workspace + "\0" + uri)
        : [...this.files.values()].find((file) => file.uri === uri)
    )?.channels.get(channel);
  }
  /** 校验可信宿主线程与共享会话的既有绑定。 */
  context(threadId: string, session: string): void {
    let t = this.threads.get(threadId);
    if (t && t.session !== session)
      throw new Error("InvalidContext：线程会话关联不一致。");
    if (!t) {
      if (this.threads.size >= 128)
        throw new Error("ResourceLimit：线程状态达到128个上限。");
      t = {
        session,
        baseline: new Map(),
        delivered: new Set(),
        summaries: new Set(),
        batches: new Map(),
        details: new Map(),
        pendingStates: new Map(),
        cursors: new Map(),
        continued: new Set(),
        pending: new Set(),
      };
      this.threads.set(threadId, t);
    }
  }
  private thread(threadId: string): Thread {
    const t = this.threads.get(threadId);
    if (!t) throw new Error("InvalidContext：缺少线程。");
    return t;
  }
  private entries(f: FileState): Map<string, Diagnostic> {
    const result = new Map<string, Diagnostic>();
    for (const c of f.channels.values())
      for (const d of c.items) result.set(key(d), d);
    return result;
  }
  private trusted(f: FileState): boolean {
    return (
      f.channels.size > 0 &&
      [...f.channels.values()].every(
        (c) => c.complete && c.version === f.version,
      )
    );
  }
  /** 写前只建立完整可信基线，不将尚未完成的通道当空。 */
  baseline(threadId: string, workspace: string): void {
    const t = this.thread(threadId);
    for (const f of this.files.values())
      if (
        f.workspace === workspace &&
        !f.deleted &&
        this.trusted(f) &&
        !t.baseline.has(f.workspace + "\0" + f.uri)
      )
        t.baseline.set(
          f.workspace + "\0" + f.uri,
          new Set(this.entries(f).keys()),
        );
  }
  /** 返回有界、完整包装后的模型上下文，重复事件重放同一批次。 */
  collect(threadId: string, workspace: string, eventId: string): string {
    const t = this.thread(threadId);
    const cached = t.batches.get(eventId);
    if (cached !== undefined) return cached;
    const batch = new FeedbackBatch(eventId);
    let omitted = 0;
    const full: string[] = [];
    const summaries: string[] = [];
    const state = (f: FileState, key: string, text: string) => {
      if (!t.delivered.has(key))
        t.pendingStates.set(key, {
          workspace: f.workspace,
          uri: f.uri,
          version: f.version,
          text,
        });
    };
    for (const f of this.files.values()) {
      if (f.workspace !== workspace) continue;
      const scope = f.workspace + "\0" + f.uri;
      if (f.excluded) {
        state(
          f,
          "excluded:" + scope + "\0" + f.epoch,
          "文件已移出自动诊断范围，不代表问题已修复：" + displayUri(f.uri),
        );
        t.baseline.delete(scope);
        continue;
      }
      if (f.deleted) {
        state(
          f,
          "deleted:" + scope + "\0" + f.epoch,
          "文件已删除：" + displayUri(f.uri),
        );
        t.baseline.delete(scope);
        continue;
      }
      const entries = this.entries(f);
      const trusted = this.trusted(f);
      const baseline = t.baseline.get(scope);
      for (const [key, diagnostic] of entries) {
        const delivery = scope + "\0" + f.epoch + "\0" + key;
        if (
          t.delivered.has(delivery) ||
          t.summaries.has(delivery) ||
          (baseline?.has(key) && !t.pending.has(delivery))
        )
          continue;
        t.pending.add(delivery);
        const diagnosticId = id(delivery);
        t.details.set(diagnosticId, { uri: f.uri, diagnostic });
        const result = batch.diagnostic({
          id: diagnosticId,
          uri: f.uri,
          diagnostic,
          version: f.version,
          generation: f.generation,
          baseline: !!baseline,
          trusted,
        });
        if (result === "full") full.push(delivery);
        else if (result === "summary") summaries.push(delivery);
        else omitted++;
      }
      if (trusted && baseline) {
        const removed = [...baseline].filter((key) => !entries.has(key));
        if (removed.length)
          state(
            f,
            "resolved:" +
              scope +
              "\0" +
              f.generation +
              "\0" +
              f.version +
              "\0" +
              id(removed.join()),
            `<resolved-diagnostics>${displayUri(f.uri)} 版本=${f.version} 已验证覆盖内服务器不再报告 ${removed.length} 项。</resolved-diagnostics>`,
          );
      }
      if (!trusted)
        state(
          f,
          "unknown:" + scope + "\0" + f.generation + "\0" + f.version,
          `<diagnostics-unknown>${displayUri(f.uri)} 版本=${f.version} 等待通道=${[
            ...f.channels,
          ]
            .filter(([, channel]) => !channel.complete)
            .map(([name]) => name.split(":").at(-1))
            .join(",")}，未宣称修复。</diagnostics-unknown>`,
        );
      if (trusted) t.baseline.set(scope, new Set(entries.keys()));
    }
    for (const [key, value] of t.pendingStates) {
      if (value.workspace !== workspace) continue;
      const current = this.files.get(workspace + "\0" + value.uri);
      if (!current || current.version !== value.version) {
        t.pendingStates.delete(key);
        continue;
      }
      if (batch.state(value.text)) {
        full.push(key);
        t.pendingStates.delete(key);
      } else omitted++;
    }
    const cursor = omitted
      ? id(threadId + "\0" + workspace + "\0" + eventId)
      : undefined;
    if (cursor) {
      t.cursors.set(cursor, workspace);
      while (t.cursors.size > 256)
        t.cursors.delete(t.cursors.keys().next().value!);
    }
    const output = batch.finish(omitted, cursor);
    for (const key of full) {
      t.delivered.add(key);
      t.pending.delete(key);
    }
    for (const key of summaries) {
      t.summaries.add(key);
      t.pending.delete(key);
    }
    while (t.delivered.size > 20000)
      t.delivered.delete(t.delivered.values().next().value!);
    while (t.summaries.size > 20000)
      t.summaries.delete(t.summaries.values().next().value!);
    while (t.details.size > 5000)
      t.details.delete(t.details.keys().next().value!);
    t.batches.set(eventId, output);
    while (t.batches.size > 256)
      t.batches.delete(t.batches.keys().next().value!);
    return output;
  }
  /** 读取本线程已观察的原始诊断与完整URI。 */
  detail(
    threadId: string,
    diagnosticId: string,
  ): { uri: string; diagnostic: Diagnostic } {
    const value = this.thread(threadId).details.get(diagnosticId);
    if (!value) throw new Error("StaleItem：诊断标识已过期或不属于当前线程。");
    return value;
  }
  /** 剩余批次只允许原线程凭游标读取，重复请求重放相同批次。 */
  remaining(threadId: string, cursor: string): string {
    const workspace = this.thread(threadId).cursors.get(cursor);
    if (!workspace) throw new Error("StaleItem：剩余游标失效或属于其他线程。");
    return this.collect(threadId, workspace, "cursor:" + cursor);
  }
  /** 每线程每原始轮最多允许一次续轮。 */
  continueOnce(threadId: string, turnId: string, active: boolean): boolean {
    const t = this.thread(threadId);
    if (active || t.continued.has(turnId)) return false;
    t.continued.add(turnId);
    if (t.continued.size > 256)
      t.continued.delete(t.continued.values().next().value!);
    return true;
  }
}
