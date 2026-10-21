import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "smol-toml";

const plugin = "codex-lsp@codex-lsp-local";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const configPath = join(home, "config.toml");
const timeout = AbortSignal.timeout(120000);
const run = (args) =>
  new Promise((resolve, reject) =>
    execFile(
      "codex",
      args,
      { signal: timeout, maxBuffer: 2000000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    ),
  );
async function restoreEnabled(enabled) {
  if (enabled !== false) return;
  const text = await fs.readFile(configPath, "utf8");
  const marker = '[plugins."' + plugin + '"]';
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("更新后找不到本插件配置，恢复已停止。");
  const end = text.indexOf("\n[", start + marker.length);
  const current = text.slice(start, end < 0 ? text.length : end);
  const next = current.replace(/^(enabled\s*=\s*)true\s*$/m, "$1false");
  const restored =
    text.slice(0, start) + next + (end < 0 ? "" : text.slice(end));
  if (parse(restored).plugins?.[plugin]?.enabled !== false)
    throw new Error("恢复启禁状态失败，备份保留。");
  const temp = configPath + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, restored, { mode: 0o600, flag: "wx" });
  await fs.rename(temp, configPath);
}
let backup;
try {
  const version = (await run(["--version"])).trim();
  if (version !== "codex-cli 0.163.0")
    throw new Error("仅核验固定 codex-cli 0.163.0，当前为 " + version);
  const info = JSON.parse(
    await fs.readFile(
      join(repository, "plugins/codex-lsp/dist/build-info.json"),
      "utf8",
    ),
  );
  const bytes = await fs.readFile(
    join(repository, "plugins/codex-lsp/dist/cli.js"),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== info.buildHash)
    throw new Error("构建哈希不匹配，拒绝安装。");
  const guard = await fs.readFile(
    join(repository, "plugins/codex-lsp/dist/guard.js"),
  );
  if (createHash("sha256").update(guard).digest("hex") !== info.guardHash)
    throw new Error("守护构建哈希不匹配，拒绝安装。");
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const config = text ? parse(text) : {};
  if (config.mcp_servers?.["codex-lsp"])
    throw new Error("发现全局独立 codex-lsp MCP，拒绝同名冲突。");
  try {
    const existing = JSON.parse(
      await run(["mcp", "get", "codex-lsp", "--json"]),
    );
    const cwd = existing.transport?.cwd;
    const cache = join(home, "plugins/cache/codex-lsp-local/codex-lsp");
    if (
      typeof cwd !== "string" ||
      relative(resolve(cache), resolve(cwd)).startsWith("..") ||
      isAbsolute(relative(resolve(cache), resolve(cwd)))
    )
      throw new Error("发现其他来源同名 codex-lsp MCP，拒绝冲突。");
  } catch (error) {
    if (!/No MCP server named|not found|does not exist/i.test(error.message))
      throw error;
  }
  const oldMarket = config.marketplaces?.["codex-lsp-local"];
  const oldEnabled = config.plugins?.[plugin]?.enabled;
  backup = join(home, "plugin-backups", "codex-lsp", randomUUID());
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(backup, "config.toml"), text, { mode: 0o600 });
  const oldCache = join(home, "plugins/cache/codex-lsp-local/codex-lsp");
  try {
    await fs.cp(oldCache, join(backup, "cache"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (oldMarket && resolve(oldMarket.source ?? "") !== repository) {
    const oldRoot = oldMarket.source;
    if (oldMarket.source_type !== "local" || !oldRoot)
      throw new Error(
        "已有同名 Git 市场，请按 VALIDATION.md 更新快照，不自动替换。",
      );
    const manifest = JSON.parse(
      await fs.readFile(
        join(oldRoot, ".agents/plugins/marketplace.json"),
        "utf8",
      ),
    );
    if (manifest.plugins?.some((p) => p.name !== "codex-lsp"))
      throw new Error("同名市场含其他插件，拒绝替换。");
    await fs.cp(oldRoot, join(backup, "marketplace"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await run(["plugin", "marketplace", "remove", "codex-lsp-local"]);
  }
  if (!oldMarket || resolve(oldMarket.source ?? "") !== repository)
    await run(["plugin", "marketplace", "add", repository]);
  await run(["plugin", "add", plugin]);
  await restoreEnabled(oldEnabled);
  await fs.writeFile(
    join(backup, "recovery.json"),
    JSON.stringify(
      {
        plugin,
        oldEnabled,
        oldMarketplace: oldMarket ?? null,
        sourceBuild: info.sourceHash,
        buildHash: info.buildHash,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        installed: plugin,
        ...info,
        newProcessRequired: true,
        hookReview: "/hooks 审阅当前定义后运行夹具。",
        backup,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(String(error));
  if (backup)
    console.error(
      "恢复备份保留于 " +
        backup +
        "，按 VALIDATION.md 进行恢复，未覆盖其他插件配置。",
    );
  process.exitCode = 1;
}
