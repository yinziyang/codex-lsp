import { validateServers } from "./server-configuration.ts";
import { createHash } from "node:crypto";
import { target } from "./servers.ts";
import { promises as fs } from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  atomicJson,
  check,
  execute,
  workspacePath,
  delay,
} from "./platform.ts";

/** 用户配置保留未知字段，只有受支持版本允许写回。 */
export interface Configuration {
  schemaVersion: number;
  authorizedWorkspaces: string[];
  servers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export const missing = (error: unknown) =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

/** 文件解析错误必须可见，不用默认配置掩盖损坏。 */
export async function readJson(
  path: string,
  fallback: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  check(signal);
  try {
    return JSON.parse(await fs.readFile(path, { encoding: "utf8", signal }));
  } catch (error) {
    if (missing(error)) return fallback;
    throw new Error("配置或记录无法解析：" + path, { cause: error });
  }
}

/** 校验配置结构及启动参数，畸形值不能进入进程创建。 */
export async function configuration(
  root: string,
  signal: AbortSignal,
): Promise<Configuration> {
  const x = (await readJson(
    join(root, "config", "settings.json"),
    { schemaVersion: 1, authorizedWorkspaces: [], servers: {} },
    signal,
  )) as Configuration;
  if (
    !x ||
    typeof x !== "object" ||
    x.schemaVersion !== 1 ||
    !Array.isArray(x.authorizedWorkspaces) ||
    !x.authorizedWorkspaces.every(
      (p) => typeof p === "string" && isAbsolute(p),
    ) ||
    !x.servers ||
    typeof x.servers !== "object" ||
    Array.isArray(x.servers)
  )
    throw new Error("Broken：配置 schemaVersion 或字段错误，原文件保留。");
  validateServers(x.servers);
  if (
    x.trustedProjects !== undefined &&
    (!x.trustedProjects ||
      typeof x.trustedProjects !== "object" ||
      Array.isArray(x.trustedProjects) ||
      !Object.values(x.trustedProjects).every(
        (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
      ))
  )
    throw new Error("Broken：项目配置信任记录格式错误。");
  return x;
}

/** 创建用户独占根，Windows 通过原生 ACL 保护控制令牌。 */
export async function secureRoot(
  root: string,
  signal: AbortSignal,
): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const script =
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[System.Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.SetAccessRule($rule);Set-Acl -LiteralPath $env:CODEX_LSP_ACL_PATH -AclObject $acl -ErrorAction Stop";
    await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      signal,
      { timeout: 5000, env: { ...process.env, CODEX_LSP_ACL_PATH: root } },
    );
  } else {
    const st = await fs.lstat(root);
    if (st.isSymbolicLink() || st.uid !== process.getuid?.())
      throw new Error("PermissionDenied：数据根所有权错误。");
    await fs.chmod(root, 0o700);
  }
}

/** 跨进程锁不盲删过期锁，等待有上界且可取消。 */
export async function locked<T>(
  root: string,
  signal: AbortSignal,
  body: () => Promise<T>,
): Promise<T> {
  await secureRoot(root, signal);
  const lock = join(root, "install.lock");
  const limit = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  while (true) {
    check(limit);
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await delay(50, limit);
    }
  }
  try {
    return await body();
  } finally {
    await fs.rmdir(lock);
  }
}

/** 显式授权工作区后，Hook 才能按需启动语言服务器。 */
export async function authorize(
  root: string,
  workspace: string,
  signal: AbortSignal,
): Promise<void> {
  const actual = (await workspacePath(workspace, undefined, signal)).root;
  await locked(root, signal, async () => {
    const config = await configuration(root, signal);
    if (!config.authorizedWorkspaces.includes(actual))
      config.authorizedWorkspaces.push(actual);
    await atomicJson(join(root, "config", "settings.json"), config, signal);
  });
}

/** 持久配置通过同一事务锁保存，未知用户字段原样保留。 */
export async function configure(
  root: string,
  language: string,
  value: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  const name = target(language);
  await locked(root, signal, async () => {
    const old = await configuration(root, signal);
    old.servers[name] = { ...old.servers[name], ...value };
    validateServers(old.servers);
    const path = join(root, "config", "settings.json");
    await atomicJson(
      path + ".backup",
      await configuration(root, signal),
      signal,
    );
    await atomicJson(path, old, signal);
    try {
      await configuration(root, signal);
    } catch (error) {
      await fs.rename(path + ".backup", path);
      throw error;
    }
  });
}

/** 单独审阅项目启动配置并记录内容摘要，普通工作区授权不会隐式信任命令。 */
export async function trustProject(
  root: string,
  workspace: string,
  signal: AbortSignal,
): Promise<string> {
  const paths = await workspacePath(workspace, ".codex-lsp.json", signal);
  const bytes = await fs.readFile(paths.file!, { signal });
  if (bytes.length > 256000) throw new Error("Broken：项目配置超过256KB。");
  const value = JSON.parse(bytes.toString("utf8"));
  validateServers(value?.servers);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await locked(root, signal, async () => {
    const config = await configuration(root, signal);
    config.trustedProjects = {
      ...((config.trustedProjects as Record<string, string>) ?? {}),
      [paths.root]: hash,
    };
    await atomicJson(join(root, "config/settings.json"), config, signal);
  });
  return hash;
}

/** 项目配置只在当前摘要仍受信任时生效，改动后恢复为未信任。 */
export async function projectOverrides(
  root: string,
  workspace: string,
  signal: AbortSignal,
): Promise<{
  servers: Record<string, Record<string, unknown>>;
  warnings: string[];
}> {
  const path = join(workspace, ".codex-lsp.json");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path, { signal });
  } catch (error) {
    if (missing(error)) return { servers: {}, warnings: [] };
    throw error;
  }
  if (bytes.length > 256000) throw new Error("Broken：项目配置超过256KB。");
  await workspacePath(workspace, ".codex-lsp.json", signal);
  const config = await configuration(root, signal);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (
    (config.trustedProjects as Record<string, string> | undefined)?.[
      workspace
    ] !== hash
  )
    return {
      servers: {},
      warnings: ["项目配置未受信任或内容已变，未执行其中启动配置。"],
    };
  const value = JSON.parse(bytes.toString("utf8"));
  return { servers: validateServers(value?.servers), warnings: [] };
}
