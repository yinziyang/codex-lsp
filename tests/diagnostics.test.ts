import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticLedger, type Diagnostic } from "../src/diagnostics.ts";
const diagnostic = (message: string): Diagnostic => ({
  message,
  severity: 1,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
});
const setup = () => {
  const ledger = new DiagnosticLedger();
  ledger.context("thread", "session");
  ledger.edit("/w", "file:///w/a.ts", 1, 1, ["push"]);
  return ledger;
};
test("首次基线未知仍反馈，线程跨轮去重，其他线程独立观察", () => {
  const l = setup();
  l.receive("file:///w/a.ts", "push", [diagnostic("A")], 1, 1);
  assert.match(l.collect("thread", "/w", "1"), /current-diagnostics/);
  assert.doesNotMatch(l.collect("thread", "/w", "2"), /current-diagnostics/);
  l.context("other", "session");
  assert.match(l.collect("other", "/w", "1"), /current-diagnostics/);
});
test("历史A仍在新增B只报B，迟到旧代次不能覆盖当前", () => {
  const l = setup();
  l.receive("file:///w/a.ts", "push", [diagnostic("A")], 1, 1);
  l.baseline("thread", "/w");
  l.edit("/w", "file:///w/a.ts", 2, 1, ["push"]);
  l.receive("file:///w/a.ts", "push", [diagnostic("A"), diagnostic("B")], 2, 1);
  l.receive("file:///w/a.ts", "push", [], 1, 1);
  const text = l.collect("thread", "/w", "2");
  assert.match(text, /new-diagnostics/);
  assert.match(text, / B</);
  assert.doesNotMatch(text, / A</);
  assert.doesNotMatch(text, /resolved-diagnostics/);
});
test("一路空一路过期不得报告修复，无版本Push不确认", () => {
  const l = setup();
  l.receive("file:///w/a.ts", "push", [diagnostic("A")], 1, 1);
  l.baseline("thread", "/w");
  l.edit("/w", "file:///w/a.ts", 2, 1, ["push", "pull"]);
  l.receive("file:///w/a.ts", "pull", [], 2, 1, "r");
  l.receive("file:///w/a.ts", "push", [], undefined, 1);
  assert.doesNotMatch(l.collect("thread", "/w", "2"), /resolved-diagnostics/);
});
test("unchanged复用resultId，不当作空", () => {
  const l = setup();
  l.receive("file:///w/a.ts", "push", [diagnostic("A")], 1, 1, "a");
  l.edit("/w", "file:///w/a.ts", 2, 1, ["push"]);
  l.receive("file:///w/a.ts", "push", [], 2, 1, "a", true);
  assert.match(l.collect("thread", "/w", "2"), / A</);
});
test("截断后未输出条目仍能后续投递", () => {
  const l = setup();
  const ds = Array.from({ length: 23 }, (_, i) => diagnostic("问题" + i));
  l.receive("file:///w/a.ts", "push", ds, 1, 1);
  const first = l.collect("thread", "/w", "1");
  assert.match(first, /剩余/);
  const next = l.collect("thread", "/w", "2");
  assert.match(next, /问题10/);
  assert.doesNotMatch(next, /问题0</);
});
test("超大中文及emoji单条摘要不超过8000字节且保留详情", () => {
  const l = setup();
  const d = diagnostic("中😀".repeat(6000));
  l.receive("file:///w/a.ts", "push", [d], 1, 1);
  const text = l.collect("thread", "/w", "1");
  assert.ok(Buffer.byteLength(text) <= 8000);
  assert.match(text, /未记完整送达/);
  const id = /id=([a-f0-9]+)/.exec(text)![1];
  assert.deepEqual(l.detail("thread", id), {
    uri: "file:///w/a.ts",
    diagnostic: d,
  });
  assert.doesNotMatch(l.collect("thread", "/w", "2"), /current-diagnostics/);
});
test("删除不报修复且重复批次完全重放", () => {
  const l = setup();
  l.receive("file:///w/a.ts", "push", [diagnostic("A")], 1, 1);
  l.baseline("thread", "/w");
  l.deleted("file:///w/a.ts");
  const first = l.collect("thread", "/w", "1");
  assert.match(first, /文件已删除/);
  assert.doesNotMatch(first, /resolved-diagnostics/);
  assert.equal(l.collect("thread", "/w", "1"), first);
});
test("共享session不同thread合法，同thread会话伪造拒绝，续轮最多一次", () => {
  const l = setup();
  l.context("child", "session");
  assert.throws(() => l.context("thread", "forged"), /InvalidContext/);
  assert.equal(l.continueOnce("thread", "turn", false), true);
  assert.equal(l.continueOnce("thread", "turn", false), false);
  assert.equal(l.continueOnce("child", "turn", true), false);
});

test("批量删除状态同样受最终预算约束且可继续投递", () => {
  const l = setup();
  for (let index = 0; index < 180; index++) {
    const uri = "file:///w/" + "文件".repeat(15) + index + ".ts";
    l.edit("/w", uri, 1, 1, ["push"]);
    l.deleted(uri);
  }
  const first = l.collect("thread", "/w", "first");
  assert.ok(Buffer.byteLength(first) <= 8000);
  assert.match(first, /剩余/);
  const second = l.collect("thread", "/w", "second");
  assert.ok(Buffer.byteLength(second) <= 8000);
  assert.notEqual(second, first);
});
test("超长URI摘要保留可查询的完整URI", () => {
  const l = new DiagnosticLedger();
  const uri = "file:///w/" + "目录".repeat(2500) + "/a.ts";
  l.context("thread", "session");
  l.edit("/w", uri, 1, 1, ["push"]);
  l.receive(uri, "push", [diagnostic("A")], 1, 1);
  const text = l.collect("thread", "/w", "1");
  assert.ok(Buffer.byteLength(text) <= 8000);
  assert.match(text, /路径摘要/);
  const id = /id=([a-f0-9]+)/.exec(text)![1];
  assert.equal((l.detail("thread", id) as any).uri, uri);
});

test("无新增无状态无剩余时输出为空，已投递诊断不产生空标题", () => {
  const ledger = new DiagnosticLedger();
  ledger.context("thread", "session");
  assert.equal(ledger.collect("thread", "/w", "empty"), "");
  ledger.edit("/w", "file:///w/a.ts", 1, 1, ["push"]);
  ledger.receive("file:///w/a.ts", "push", [diagnostic("A")], 1, 1);
  assert.match(ledger.collect("thread", "/w", "first"), /current-diagnostics/);
  assert.equal(ledger.collect("thread", "/w", "next"), "");
  assert.equal(ledger.collect("thread", "/w", "empty"), "");
});
