import { isAbsolute } from "node:path";
import { LspClient, type ClientOptions } from "../extensions/pi-lsp/client.ts";
import { spawnServer } from "../extensions/pi-lsp/process.ts";
/** 两个宿主共用私有守护绑定，防止资源归属环境或管道收尾行为分叉。 */
export function guardedClient(
  options: ClientOptions,
  guardPath: string,
  dataRoot: string,
  coreId: string,
): LspClient {
  if (!isAbsolute(guardPath) || !isAbsolute(dataRoot) || !coreId)
    throw new Error("InvalidContext：守护归属参数不完整。");
  return new LspClient({
    ...options,
    spawn: (command, args, cwd, env) =>
      spawnServer(process.execPath, [guardPath, command, ...args], cwd, {
        ...env,
        CODEX_LSP_GUARD_DATA: dataRoot,
        CODEX_LSP_GUARD_CORE: coreId,
        CODEX_LSP_GUARD_SERVER: options.name,
      }),
  });
}
