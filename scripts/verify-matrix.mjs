import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const output = resolve(
  process.env.CODEX_LSP_EVIDENCE ?? ".artifacts/real-matrix",
);
const matrix = JSON.parse(
  await fs.readFile(join(output, "real-server-matrix.json"), "utf8"),
);
const summary = (value) =>
  value && typeof value === "object"
    ? Object.fromEntries(
        ["name", "kind", "uri", "range", "selectionRange"]
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, value[key]]),
      )
    : value;
const checks = [];
for (const server of matrix) {
  if (server.status === "NotTested") continue;
  assert.equal(server.exitCode, 0, server.server);
  const trace = (
    await fs.readFile(join(output, server.server + "-protocol.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    trace.some(
      (value) =>
        value.event === "lsp-wire" &&
        value.direction === "send" &&
        value.message?.method === "initialize",
    ),
  );
  assert.ok(server.initialize?.capabilities);
  for (const row of server.operations) {
    assert.ok(
      ["Supported", "Unsupported"].includes(row.status),
      server.server + ":" + row.operation,
    );
    if (row.status === "Unsupported") continue;
    const wire = trace.find(
      (value) =>
        value.event === "semantic" && value.operation === row.operation,
    );
    assert.ok(wire, server.server + ":" + row.operation + "缺少原始响应");
    let expected = wire.result;
    if (Array.isArray(expected))
      expected = [
        ...new Map(
          expected.map((value) => [JSON.stringify(value), value]),
        ).values(),
      ].slice(0, 100);
    if (row.operation === "prepareCallHierarchy" && Array.isArray(expected))
      expected = expected.map(summary);
    assert.deepEqual(
      row.result.result,
      expected,
      server.server + ":" + row.operation + "规范化原始JSON不一致",
    );
    checks.push({
      server: server.server,
      operation: row.operation,
      rawComparison: "passed",
      empty: row.empty,
    });
  }
  if (!["html", "css"].includes(server.server)) {
    const definition = server.operations.find(
      (value) => value.operation === "goToDefinition",
    );
    assert.equal(definition.empty, false, server.server + "定义夹具不得全空");
  }
}
await fs.writeFile(
  join(output, "raw-comparison.json"),
  JSON.stringify({ checks }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    compared: checks.length,
    servers: matrix.length,
    status: "passed",
  }),
);
