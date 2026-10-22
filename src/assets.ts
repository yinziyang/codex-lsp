import { inspectProcess } from "./process-identity.ts";
import { guardLeases } from "./guard-leases.ts";
import { target } from "./servers.ts";
import { promises as fs } from "node:fs";
import { join, resolve, isAbsolute, relative, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { atomicJson, execute, findCommand } from "./platform.ts";
import { locked, readJson, missing } from "./configuration.ts";
import { runtimes, control } from "./runtime.ts";
import { catalog } from "./catalog.ts";

/** 资产记录只覆盖本插件创建的独占目录，消费者与租约分别校验。 */
export interface Asset {
  schemaVersion: 1;
  creator: "codex-lsp";
  transaction: string;
  unit: string;
  path: string;
  version: string;
  checksum: string;
  consumers: string[];
  binDirectory: string;
  source: string;
  retained?: {
    path: string;
    transaction: string;
    checksum: string;
    version: string;
  }[];
}

const packages: Record<string, string[]> = {
  typescript: ["typescript@5.9.3", "typescript-language-server@5.0.0"],
  pyright: ["pyright@1.1.414"],
  basedpyright: ["basedpyright@1.40.2"],
  html: ["vscode-langservers-extracted@4.10.0"],
  css: ["vscode-langservers-extracted@4.10.0"],
};

/** 资产清单损坏会阻断卸载，不按目录名猜所有权。 */
export async function assets(
  root: string,
  signal: AbortSignal,
): Promise<Asset[]> {
  const dir = join(root, "ownership");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const result: Asset[] = [];
  for (const name of names) {
    if (!/^[a-z-]+\.json$/.test(name)) continue;
    const x = (await readJson(join(dir, name), null, signal)) as Asset;
    if (
      !x ||
      x.schemaVersion !== 1 ||
      x.creator !== "codex-lsp" ||
      !Array.isArray(x.consumers) ||
      !x.consumers.every((v) => typeof v === "string") ||
      !isAbsolute(x.path) ||
      relative(join(root, "assets"), x.path).startsWith("..") ||
      !x.transaction ||
      !x.checksum
    )
      throw new Error("Broken：资产所有权记录不合法。");
    result.push(x);
  }
  return result;
}

/** 只生成可审阅的固定版本安装计划，不执行下载或创建目录。 */
export function installPlan(
  language: string,
  root: string,
): Record<string, unknown> {
  const server = target(language);
  const unit = server === "html" || server === "css" ? "web" : server;
  const versions = packages[server];
  if (server === "clangd")
    return {
      server,
      status: "Instructions",
      macOS: "使用已安装 Xcode Command Line Tools 的 clangd。",
      linux: "请审阅发行版系统包管理器提供的 clangd，插件不安装系统软件。",
      windows: "请从 LLVM 官方发行包安装 clangd 原生 exe。",
    };
  if (server === "rust-analyzer")
    return {
      server,
      status: "RequiresPinnedAsset",
      instructions:
        "使用 install-asset rust --url 官方GitHub发行资产 --sha256 校验值 --version 固定版本，不修改 rustup 用户工具链。",
    };
  return {
    server,
    unit,
    version: server === "gopls" ? "v0.22.0" : versions.join(","),
    source:
      server === "gopls"
        ? "https://proxy.golang.org/"
        : "https://registry.npmjs.org/",
    directory: join(root, "assets", unit),
    command:
      server === "gopls"
        ? ["go", "install", "golang.org/x/tools/gopls@v0.22.0"]
        : [
            "npm",
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            ...versions,
          ],
    sideEffects: "仅插件私有事务目录写入；可能联网；验证失败保留旧资产。",
    integrity: versions?.map((spec) => catalog[spec as keyof typeof catalog]),
    authorization: "通过 Codex 原生 Shell 审批执行包内 CLI。",
  };
}

/** 安装前后都持锁，新资产真实初始化成功后才提交所有权。 */
export async function install(
  root: string,
  language: string,
  signal: AbortSignal,
  verify: (bin: string, server: string) => Promise<void>,
): Promise<Asset> {
  const server = target(language);
  if (!packages[server] && server !== "gopls")
    throw new Error("该服务器需使用安装指引或固定官方资产。");
  const unit = ["html", "css"].includes(server) ? "web" : server;
  return locked(root, signal, async () => {
    const all = await assets(root, signal);
    const old = all.find((x) => x.unit === unit);
    if (old && old.version === String(installPlan(server, root).version)) {
      await verify(old.binDirectory, server);
      if (!old.consumers.includes(server)) {
        old.consumers.push(server);
        await atomicJson(join(root, "ownership", unit + ".json"), old, signal);
      }
      return old;
    }
    const transaction = randomUUID();
    const stage = join(root, "assets", unit + "-" + transaction);
    await fs.mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      let bin: string;
      let checksum: string;
      if (server === "gopls") {
        bin = join(stage, "bin");
        await fs.mkdir(bin);
        await execute(
          "go",
          ["install", "golang.org/x/tools/gopls@v0.22.0"],
          signal,
          {
            env: { ...process.env, GOBIN: bin, GOSUMDB: "sum.golang.org" },
            timeout: 600000,
          },
        );
        checksum = createHash("sha256")
          .update(
            await fs.readFile(
              join(bin, process.platform === "win32" ? "gopls.exe" : "gopls"),
            ),
          )
          .digest("hex");
      } else {
        const npm = await findCommand(
          "npm",
          process.env,
          process.platform,
          signal,
        );
        if (!npm) throw new Error("Missing：需要现有 npm。");
        let command = npm;
        let args = [
          "install",
          "--prefix",
          stage,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--save-exact",
          "--registry=https://registry.npmjs.org/",
          "--cache",
          join(stage, ".npm-cache"),
          ...packages[server],
        ];
        if (process.platform === "win32") {
          const cli = resolve(
            dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          );
          command = process.execPath;
          args = [cli, ...args];
        }
        await execute(command, [...args, "--package-lock-only"], signal, {
          timeout: 600000,
        });
        const planned = JSON.parse(
          await fs.readFile(join(stage, "package-lock.json"), "utf8"),
        );
        for (const spec of packages[server]) {
          const split = spec.lastIndexOf("@");
          const name = spec.slice(0, split);
          if (
            planned.packages?.["node_modules/" + name]?.integrity !==
            catalog[spec as keyof typeof catalog].integrity
          )
            throw new Error("IntegrityError：注册表完整性与固定目录不一致。");
        }
        const ci =
          process.platform === "win32"
            ? [
                resolve(
                  dirname(process.execPath),
                  "node_modules",
                  "npm",
                  "bin",
                  "npm-cli.js",
                ),
                "ci",
              ]
            : ["ci"];
        await execute(
          command,
          [
            ...ci,
            "--prefix",
            stage,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
          ],
          signal,
          { timeout: 600000 },
        );
        bin = join(stage, "node_modules", ".bin");
        // basedpyright包额外导出pyright别名，移除本插件生成的这些入口以免私有PATH抢占原pyright。
        if (server === "basedpyright")
          for (const name of ["pyright", "pyright-langserver"])
            for (const suffix of ["", ".cmd", ".ps1"])
              await fs.rm(join(bin, name + suffix), { force: true });
        const lock = JSON.parse(
          await fs.readFile(join(stage, "package-lock.json"), "utf8"),
        );
        for (const value of Object.values(lock.packages ?? {}) as Record<
          string,
          unknown
        >[])
          if (value.version && !value.integrity)
            throw new Error("IntegrityError：npm 锁文件缺少完整性校验。");
        checksum = createHash("sha256")
          .update(JSON.stringify(lock))
          .digest("hex");
      }
      await verify(bin, server);
      const asset: Asset = {
        schemaVersion: 1,
        creator: "codex-lsp",
        transaction,
        unit,
        path: stage,
        version: String(installPlan(server, root).version),
        checksum,
        consumers: [...new Set([...(old?.consumers ?? []), server])],
        binDirectory: bin,
        source: String(installPlan(server, root).source),
        retained: old
          ? [
              ...(old.retained ?? []),
              {
                path: old.path,
                transaction: old.transaction,
                checksum: old.checksum,
                version: old.version,
              },
            ]
          : [],
      };
      await atomicJson(join(root, "ownership", unit + ".json"), asset, signal);
      return asset;
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  });
}

/** 资产仍有活动租约时拒绝卸载，失效记录不触发任意进程终止。 */
export async function uninstall(
  root: string,
  language: string,
  signal: AbortSignal,
): Promise<void> {
  const server = target(language);
  await locked(root, signal, async () => {
    for (const guard of await guardLeases(root, signal))
      if (guard.lease.server === server && guard.state !== "gone")
        throw new Error("AssetInUse：守护或LS残留尚未确认退出。");
    for (const record of await runtimes(root, signal)) {
      try {
        await control(record, "status", undefined, signal);
        if (record.assets.includes(server))
          throw new Error("AssetInUse：请先停止拥有该资产的实例。");
      } catch (error) {
        if (String(error).includes("AssetInUse")) throw error;
        if (
          record.assets.includes(server) &&
          (await inspectProcess(record.pid, signal)).state !== "gone"
        )
          throw new Error("AssetInUse：实例端点失效但进程状态尚未确认退出。");
      }
    }
    const all = await assets(root, signal);
    const asset = all.find((x) => x.consumers.includes(server));
    if (!asset)
      throw new Error("NotOwned：未发现本插件拥有的资产，不删除用户工具。");
    asset.consumers = asset.consumers.filter((x) => x !== server);
    if (asset.consumers.length) {
      await atomicJson(
        join(root, "ownership", asset.unit + ".json"),
        asset,
        signal,
      );
      return;
    }
    for (const retained of asset.retained ?? []) {
      if (
        typeof retained.path !== "string" ||
        !isAbsolute(retained.path) ||
        relative(join(root, "assets"), retained.path).startsWith("..")
      )
        throw new Error("OwnershipError：旧资产路径错误。");
      const actual = await fs.realpath(retained.path);
      if (actual !== retained.path)
        throw new Error("OwnershipError：旧资产真实路径不匹配。");
      await fs.rm(actual, { recursive: true });
    }
    const real = await fs.realpath(asset.path);
    if (
      real !== asset.path ||
      relative(join(root, "assets"), real).startsWith("..")
    )
      throw new Error("OwnershipError：真实资产路径不匹配。");
    await fs.rm(real, { recursive: true });
    await fs.rm(join(root, "ownership", asset.unit + ".json"));
  });
}
