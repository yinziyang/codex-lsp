import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configuredServers,
  validateServers,
} from "../src/server-configuration.ts";
import { loadSettings } from "../extensions/pi-lsp/config.ts";
import { fileNotifications } from "../src/file-events.ts";

test("项目覆盖不重新启用用户禁用项且不污染其他工作区", () => {
  const original = loadSettings({
    agentDir: "/not-existing",
    cwd: process.cwd(),
    trusted: false,
  }).settings.servers;
  const first = configuredServers(
    original,
    { typescript: { enabled: false, args: ["first"] } },
    { typescript: { enabled: true, command: "custom" } },
  );
  const entry = first.find((value) => value.config.name === "typescript")!;
  assert.equal(entry.enabled, false);
  assert.equal(entry.config.builtin, false);
  assert.equal(entry.config.argsOverridden, true);
  const second = configuredServers(original, {});
  assert.notEqual(
    second.find((value) => value.config.name === "typescript")!.config.command,
    "custom",
  );
  assert.throws(() => validateServers({ go: {} }), /Broken/);
  assert.throws(() => validateServers({ gopls: { env: [] } }), /Broken/);
});

test("仅匹配已声明文件事件且遵守kind和folder过滤", () => {
  const root = process.cwd();
  const file = join(root, "nested", "MAIN.ts");
  const options = new Map<string, unknown>([
    [
      "workspace/didChangeWatchedFiles",
      {
        watchers: [
          {
            globPattern: {
              baseUri: { uri: pathToFileURL(root).href, name: "root" },
              pattern: "**/*.ts",
            },
            kind: 5,
          },
        ],
      },
    ],
  ]);
  const capabilities = {
    workspace: {
      fileOperations: {
        didCreate: {
          filters: [
            {
              scheme: "file",
              pattern: {
                glob: "**/*.TS",
                matches: "file",
                options: { ignoreCase: true },
              },
            },
          ],
        },
        didDelete: {
          filters: [{ pattern: { glob: "**/*", matches: "folder" } }],
        },
      },
    },
  };
  assert.deepEqual(
    fileNotifications(capabilities, options, root, file, 1).map(
      (value) => value.method,
    ),
    ["workspace/didChangeWatchedFiles", "workspace/didCreateFiles"],
  );
  assert.equal(
    fileNotifications(capabilities, options, root, file, 2).length,
    0,
  );
  assert.deepEqual(
    fileNotifications(capabilities, options, root, file, 3).map(
      (value) => value.method,
    ),
    ["workspace/didChangeWatchedFiles"],
  );
  assert.equal(fileNotifications({}, new Map(), root, file, 1).length, 0);
});
