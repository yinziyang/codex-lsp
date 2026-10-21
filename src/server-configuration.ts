import { aliases } from "./servers.ts";
import type { ServerConfig } from "../extensions/pi-lsp/config.ts";
/** 用户和项目共用服务器字段校验，缺字段与类型错误同样拒绝。 */
export function validateServers(
  value: unknown,
): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Broken：servers 必须为对象。");
  const servers = value as Record<string, Record<string, unknown>>;
  for (const [name, s] of Object.entries(servers)) {
    if (
      aliases[name] !== name ||
      !s ||
      typeof s !== "object" ||
      Array.isArray(s)
    )
      throw new Error("Broken：服务器配置错误。");
    if (
      s.command !== undefined &&
      (typeof s.command !== "string" || !s.command)
    )
      throw new Error("Broken：command 必须为非空字符串。");
    if (
      s.args !== undefined &&
      (!Array.isArray(s.args) || !s.args.every((v) => typeof v === "string"))
    )
      throw new Error("Broken：args 必须为字符串数组。");
    if (s.enabled !== undefined && typeof s.enabled !== "boolean")
      throw new Error("Broken：enabled 必须为布尔值。");
    if (
      s.env !== undefined &&
      (!s.env ||
        typeof s.env !== "object" ||
        Array.isArray(s.env) ||
        Object.values(s.env).some((v) => typeof v !== "string"))
    )
      throw new Error("Broken：env 必须为字符串映射。");
  }
  return servers;
}

/** 可信项目覆盖用户配置，但用户显式禁用始终作为上限。 */
export function configuredServers(
  servers: ServerConfig[],
  user: Record<string, Record<string, unknown>>,
  project: Record<string, Record<string, unknown>> = {},
): { config: ServerConfig; enabled: boolean }[] {
  validateServers(user);
  validateServers(project);
  return servers.map((original) => {
    const config = structuredClone(original);
    const override: Record<string, unknown> = {
      ...user[config.name],
      ...project[config.name],
      ...(user[config.name]?.enabled === false ? { enabled: false } : {}),
    };
    if (typeof override.command === "string") {
      config.command = override.command;
      config.builtin = false;
    }
    if (Array.isArray(override.args)) {
      config.args = override.args as string[];
      config.argsOverridden = true;
    }
    if (override.env) config.env = override.env as Record<string, string>;
    for (const field of ["settings", "initializationOptions"] as const)
      if (override[field] !== undefined) config[field] = override[field];
    return { config, enabled: override.enabled !== false };
  });
}
