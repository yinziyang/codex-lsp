import { promises as fs, constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import ignore, { type Ignore } from "ignore";
import { check } from "./platform.ts";

/** 每层gitignore绑定自己的目录，禁止将子目录规则错误应用于其他项目。 */
export interface IgnoreRule {
  root: string;
  filter: Ignore;
}
/** 按平台路径段判断包含关系，拒绝父目录逃逸和跨盘绝对路径。 */
export const inside = (root: string, path: string) => {
  const name = relative(root, path);
  return (
    !isAbsolute(name) &&
    name !== ".." &&
    !name.startsWith("../") &&
    !name.startsWith("..\\")
  );
};
/** maximum为0至2000000字节，打开后复核路径和身份，拒绝符号链接、FIFO和超预算增长，始终释放句柄。 */
export async function readScanFile(
  root: string,
  path: string,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  check(signal);
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 2000000)
    throw new Error("InvalidInput：文件读取预算无效。");
  if (!inside(root, path) || (await fs.realpath(path)) !== path)
    throw new Error("文件真实路径越界或改变。");
  // 非阻塞打开使扫描后换成FIFO的输入也能立即进入普通文件身份检查。
  const handle = await fs.open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    const real = await fs.realpath(path);
    const current = await fs.lstat(path);
    if (
      real !== path ||
      current.isSymbolicLink() ||
      !opened.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error("文件在打开期间被替换或真实路径越界。");
    if (opened.size > maximum) throw new Error("文件超过读取预算。");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      check(signal);
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("读取时文件超过预算。");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
/** 每层最多读取128KB的UTF-8规则，规则不存在时继承，损坏或越界时由调用方报告覆盖不完整。 */
export async function ignoreRules(
  root: string,
  inherited: IgnoreRule[],
  signal: AbortSignal,
): Promise<IgnoreRule[]> {
  const path = join(root, ".gitignore");
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink())
      throw new Error("跳过符号链接gitignore，无法确认完整忽略规则。");
    if (stat.size > 128000) throw new Error("gitignore超过128KB预算。");
    const bytes = await readScanFile(root, path, 128000, signal);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return [...inherited, { root, filter: ignore().add(text) }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return inherited;
    throw error;
  }
}
/** 按继承顺序合并忽略及否定规则，目录末尾斜线遵循gitignore语义。 */
export function ignored(
  path: string,
  directory: boolean,
  filters: IgnoreRule[],
): boolean {
  let answer = false;
  for (const rule of filters) {
    const name =
      relative(rule.root, path).replaceAll("\\", "/") + (directory ? "/" : "");
    const result = rule.filter.test(name);
    if (result.ignored) answer = true;
    else if (result.unignored) answer = false;
  }
  return answer;
}
