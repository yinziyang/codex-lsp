import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
const manifestPath = join(root, "plugins/codex-lsp/.codex-plugin/plugin.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
const sourceFiles = [];
async function walk(dir) {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else sourceFiles.push(path);
  }
}
for (const directory of [
  "src",
  "extensions/pi-lsp",
  "plugins/codex-lsp/skills",
  "plugins/codex-lsp/hooks",
  "plugins/codex-lsp/.codex-plugin",
])
  await walk(join(root, directory));
for (const file of [
  "package-lock.json",
  "package.json",
  "scripts/build.mjs",
  "scripts/plugin-install.mjs",
  "plugins/codex-lsp/mcp.json",
  ".agents/plugins/marketplace.json",
])
  sourceFiles.push(join(root, file));
const hash = createHash("sha256");
const portable = (path) => relative(root, path).replaceAll("\\", "/");
for (const path of sourceFiles.sort((a, b) =>
  portable(a).localeCompare(portable(b)),
)) {
  const bytes = await fs.readFile(path);
  hash.update(portable(path) + "\0" + bytes.length + "\0").update(bytes);
}
const sourceHash = hash.digest("hex");
const output = join(root, "plugins/codex-lsp/dist");
await fs.mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, "src/cli.ts")],
  outfile: join(output, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.18",
  banner: {
    js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
  },
  define: {
    __BUILD_HASH__: JSON.stringify(sourceHash),
    __VERSION__: JSON.stringify(pkg.version),
  },
  legalComments: "eof",
  minifyWhitespace: true,
  minify: false,
});
await build({
  entryPoints: [join(root, "src/command-entry.ts")],
  outfile: join(output, "command.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.18",
  banner: {
    js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
  },
  legalComments: "eof",
  minifyWhitespace: true,
});
await build({
  entryPoints: [join(root, "src/guard.ts")],
  outfile: join(output, "guard.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.18",
  banner: {
    js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
  },
  legalComments: "eof",
  minifyWhitespace: true,
});
const guardHash = createHash("sha256")
  .update(await fs.readFile(join(output, "guard.js")))
  .digest("hex");
const commandHash = createHash("sha256")
  .update(await fs.readFile(join(output, "command.js")))
  .digest("hex");
const buildHash = createHash("sha256")
  .update(await fs.readFile(join(output, "cli.js")))
  .digest("hex");
await fs.writeFile(
  join(output, "build-info.json"),
  JSON.stringify(
    {
      version: pkg.version,
      sourceHash,
      buildHash,
      guardHash,
      commandHash,
      upstream: "ff1004afc819c6f39d217949784c712c0e68ca0e",
      codex: "83086188ae0614bd882818ff1aa23f3194962012",
      format: "official-legacy-plugin",
    },
    null,
    2,
  ) + "\n",
);
await fs.copyFile(
  join(root, "LICENSE"),
  join(root, "plugins/codex-lsp/LICENSE"),
);
console.log(JSON.stringify({ sourceHash, buildHash }));

await fs.mkdir(join(root, "dist"), { recursive: true });
await build({
  entryPoints: [join(root, "scripts/plugin-install.mjs")],
  outfile: join(root, "dist/plugin-install.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.18",
  legalComments: "eof",
  minifyWhitespace: true,
});
