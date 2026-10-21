import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
const info = JSON.parse(
  await fs.readFile("plugins/codex-lsp/dist/build-info.json", "utf8"),
);
const artifacts = [];
for (const path of [
  "plugins/codex-lsp/dist/cli.js",
  "plugins/codex-lsp/dist/guard.js",
  "plugins/codex-lsp/dist/build-info.json",
  "dist/plugin-install.mjs",
]) {
  const content = await fs.readFile(path);
  artifacts.push({
    path,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
await fs.writeFile(
  "ARTIFACTS.json",
  JSON.stringify({ ...info, artifacts }, null, 2) + "\n",
);
