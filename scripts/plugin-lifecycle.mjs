import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(join(tmpdir(), "codex-lsp-plugin-"));
const home = join(temporary, "home");
const old = join(temporary, "old");
const run = (command, args, cwd = repository) => {
  const value = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(value.status, 0, value.stderr + value.stdout);
  return value.stdout;
};
try {
  await fs.mkdir(home);
  await fs.mkdir(old);
  for (const path of [
    "src",
    "extensions",
    "plugins",
    "scripts",
    ".agents",
    "LICENSE",
    "package.json",
    "package-lock.json",
  ])
    await fs.cp(join(repository, path), join(old, path), { recursive: true });
  await fs.symlink(
    join(repository, "node_modules"),
    join(old, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const pkg = JSON.parse(await fs.readFile(join(old, "package.json"), "utf8"));
  pkg.version = "0.0.9";
  await fs.writeFile(join(old, "package.json"), JSON.stringify(pkg));
  run(process.execPath, ["scripts/build.mjs"], old);
  run(process.execPath, [join(old, "dist/plugin-install.mjs")]);
  const plugin = "codex-lsp@codex-lsp-local";
  const before = JSON.parse(run("codex", ["plugin", "list", "--json"]));
  const configPath = join(home, "config.toml");
  const enabled = await fs.readFile(configPath, "utf8");
  assert.match(enabled, /enabled = true/);
  await fs.writeFile(
    configPath,
    enabled.replace(/enabled = true/, "enabled = false"),
  );
  run(process.execPath, ["dist/plugin-install.mjs"]);
  const after = JSON.parse(run("codex", ["plugin", "list", "--json"]));
  const config = await fs.readFile(join(home, "config.toml"), "utf8");
  assert.match(config, /enabled = false/);
  const current = JSON.parse(
    await fs.readFile(
      join(repository, "plugins/codex-lsp/dist/build-info.json"),
      "utf8",
    ),
  );
  const cache = join(
    home,
    "plugins/cache/codex-lsp-local/codex-lsp",
    current.version,
  );
  const loaded = JSON.parse(
    await fs.readFile(join(cache, "dist/build-info.json"), "utf8"),
  );
  assert.equal(loaded.buildHash, current.buildHash);
  await fs.writeFile(
    configPath,
    config.replace(/enabled = false/, "enabled = true"),
  );
  run("codex", ["plugin", "remove", plugin]);
  run("codex", ["plugin", "marketplace", "remove", "codex-lsp-local"]);
  assert.ok(
    !(await fs.readFile(join(home, "config.toml"), "utf8")).includes(
      "[mcp_servers.codex-lsp]",
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      before,
      after,
      loaded,
      preservedDisabled: true,
      removed: true,
      globalMcpCreated: false,
    }),
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
