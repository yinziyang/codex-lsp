import { matchesGlob, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function matches(value: unknown, root: string, file: string): boolean {
  if (typeof value === "string")
    return (
      matchesGlob(file.replaceAll("\\", "/"), value) ||
      matchesGlob(relative(root, file).replaceAll("\\", "/"), value)
    );
  if (
    object(value) &&
    typeof value.pattern === "string" &&
    (typeof value.baseUri === "string" ||
      (object(value.baseUri) && typeof value.baseUri.uri === "string"))
  ) {
    try {
      return matchesGlob(
        relative(
          fileURLToPath(
            typeof value.baseUri === "string"
              ? value.baseUri
              : (value.baseUri as { uri: string }).uri,
          ),
          file,
        ).replaceAll("\\", "/"),
        value.pattern,
      );
    } catch {
      return false;
    }
  }
  return false;
}
/** 只为声明或动态注册且过滤器匹配的文件事件生成协议通知。 */
export function fileNotifications(
  capabilities: unknown,
  options: Map<string, unknown>,
  root: string,
  file: string,
  type: 1 | 2 | 3,
): { method: string; params: unknown }[] {
  const result: { method: string; params: unknown }[] = [];
  const watched = options.get("workspace/didChangeWatchedFiles");
  const kind = type === 1 ? 1 : type === 2 ? 2 : 4;
  if (
    object(watched) &&
    Array.isArray(watched.watchers) &&
    watched.watchers.some(
      (value) =>
        object(value) &&
        matches(value.globPattern, root, file) &&
        (value.kind === undefined ||
          (typeof value.kind === "number" && (value.kind & kind) !== 0)),
    )
  )
    result.push({
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: pathToFileURL(file).href, type }] },
    });
  const cap = capabilities as {
    workspace?: { fileOperations?: Record<string, unknown> };
  };
  const key = type === 1 ? "didCreate" : type === 3 ? "didDelete" : undefined;
  if (!key) return result;
  const registration =
    options.get("workspace/" + key + "Files") ??
    cap?.workspace?.fileOperations?.[key];
  if (
    object(registration) &&
    Array.isArray(registration.filters) &&
    registration.filters.some(
      (filter) =>
        object(filter) &&
        (filter.scheme === undefined || filter.scheme === "file") &&
        object(filter.pattern) &&
        typeof filter.pattern.glob === "string" &&
        filter.pattern.matches !== "folder" &&
        matches(
          filter.pattern.options &&
            object(filter.pattern.options) &&
            filter.pattern.options.ignoreCase === true
            ? filter.pattern.glob.toLowerCase()
            : filter.pattern.glob,
          filter.pattern.options &&
            object(filter.pattern.options) &&
            filter.pattern.options.ignoreCase === true
            ? root.toLowerCase()
            : root,
          filter.pattern.options &&
            object(filter.pattern.options) &&
            filter.pattern.options.ignoreCase === true
            ? file.toLowerCase()
            : file,
        ),
    )
  )
    result.push({
      method: "workspace/" + key + "Files",
      params: { files: [{ uri: pathToFileURL(file).href }] },
    });
  return result;
}
