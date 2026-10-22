import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSemanticResult } from "../src/semantic.ts";

/** 输出契约以实际序列化字节验收，不依赖JavaScript字符串长度估算。 */
test("紧凑响应保留中文emoji真实警告、标明省略和缩短，并拒绝复制任意字段", () => {
  const warnings = [
    "扫描达到128文件上限。",
    "读取失败🙂中文".repeat(10000),
    "目录超预算😀".repeat(10000),
    "第四项警告",
    "第五项警告",
  ];
  const result = compactSemanticResult(
    {
      status: "Supported",
      operation: "workspaceSymbol",
      generation: 2,
      source: "documentSymbol-aggregation",
      complete: true,
      scannedFiles: 128,
      warnings,
      text: "\u0000\n🙂中文".repeat(10000),
      query: "x".repeat(100000),
      scopeRoot: "/" + "private/".repeat(20000),
      arbitrary: "禁止复制".repeat(10000),
    },
    "page-id",
  );
  assert.equal(result.source, "documentSymbol-aggregation");
  assert.equal(result.complete, false);
  const visible = result.warnings as string[];
  assert.equal(visible[0], warnings[0]);
  assert.equal(visible.length, 3);
  assert.ok(visible[1].startsWith("读取失败🙂中文"));
  assert.ok(visible[2].startsWith("目录超预算😀"));
  assert.ok(visible.every((warning) => Array.from(warning).length <= 100));
  assert.equal(result.warningsOmitted, 2);
  assert.equal(result.warningsTruncated, 2);
  for (const field of ["query", "scopeRoot", "arbitrary"])
    assert.equal(field in result, false);
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 32000);
  assert.deepEqual(JSON.parse(serialized).warnings, visible);
});

test("无详情缓存的紧凑首响应仍有真实覆盖原因且满足相同字节契约", () => {
  const result = compactSemanticResult({
    status: "Supported",
    operation: "hover",
    generation: 1,
    warnings: ["服务响应已超详情上限🙂".repeat(1000)],
    text: "\ud800\n中文😀".repeat(10000),
  });
  assert.equal(result.responseId, undefined);
  assert.match(String(result.detail), /缩小/);
  assert.match(JSON.stringify(result.warnings), /服务响应已超详情上限/);
  assert.equal(result.warningsOmitted, 0);
  assert.equal(result.warningsTruncated, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 32000);
});

test("最终JSON校验拒绝超过首响应预算的异常元数据", () => {
  assert.throws(
    () =>
      compactSemanticResult({
        status: "Supported",
        operation: "workspaceSymbol",
        source: "超长来源🙂".repeat(10000),
        text: "短正文",
      }),
    /32000/,
  );
});
