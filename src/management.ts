import { join } from "node:path";

/** 状态表使用独立列区分启用与安装，Disabled 不能冒充未安装。 */
export function statusTable(
  rows: { server: string; status: string; enabled?: boolean; path?: string }[],
  mode: string,
): string {
  const header = ["语言服务器", "启用", "安装状态", "可执行文件"];
  const state: Record<string, string> = {
    Installed: "已检测到",
    Missing: "未安装",
    Disabled: "未检查",
    Ready: "就绪",
    Broken: "异常",
    PermissionRequired: "需授权",
  };
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  const values = rows.map((row) => [
    clean(row.server),
    row.enabled === false ? "否" : "是",
    state[row.status] ?? clean(row.status),
    clean(row.path ?? "—"),
  ]);
  const width = (s: string) =>
    [...s].reduce((n, c) => n + (/[^\x00-\xff]/.test(c) ? 2 : 1), 0);
  const widths = header.map((value, i) =>
    Math.max(width(value), ...values.map((row) => width(row[i]))),
  );
  const line = (row: string[]) =>
    row
      .map((s, i) => s + " ".repeat(widths[i] - width(s)))
      .join("  ")
      .trimEnd();
  return (
    [
      line(header),
      ...values.map(line),
      "",
      `项目授权：${mode === "explicit" ? "逐项目授权" : "自动，无需逐项目确认"}`,
      "已检测到表示找到可执行文件；doctor 真实初始化后才表示就绪。",
    ].join("\n") + "\n"
  );
}

/** Python 选择只接受两种已支持服务器，不接受任意包或启动命令。 */
export function pythonServer(value: string): string {
  const names: Record<string, string> = {
    "1": "basedpyright",
    "2": "pyright",
    basedpyright: "basedpyright",
    pyright: "pyright",
  };
  const key = value.trim().toLowerCase();
  if (!Object.hasOwn(names, key))
    throw new Error("InvalidInput：请选择 1/basedpyright 或 2/pyright。");
  const selected = names[key];
  return selected;
}

/** 稳定命令跟随当前安装版本，不绑定某次安装缓存或仓库工作目录。 */
export function installedCommand(value: unknown, home: string): string {
  const installed = (value as { installed?: unknown })?.installed;
  if (!Array.isArray(installed))
    throw new Error("Broken：Codex 插件列表格式错误。");
  const plugin = installed.find(
    (p) => p?.pluginId === "codex-lsp@codex-lsp-local",
  );
  if (!plugin?.installed) throw new Error("Missing：尚未安装 codex-lsp 插件。");
  if (
    typeof plugin.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(plugin.version)
  )
    throw new Error("Broken：插件版本格式错误。");
  return join(
    home,
    "plugins/cache/codex-lsp-local/codex-lsp",
    plugin.version,
    "dist/cli.js",
  );
}
