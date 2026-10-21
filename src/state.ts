import type { LspClient } from "../extensions/pi-lsp/client.ts";
import type { Router, Launch } from "../extensions/pi-lsp/routing.ts";
import type { ServerConfig } from "../extensions/pi-lsp/config.ts";
import type { DiskFile } from "./platform.ts";
import type { WorkspaceIndex } from "./workspace.ts";

/** 共享核心内部状态契约，由同一资源拥有者管理。 */
export interface Document {
  text: string;
  hash: string;
  version: number;
  opened: boolean;
}

/** 共享核心内部状态契约，由同一资源拥有者管理。 */
export interface Instance {
  key: string;
  workspace: string;
  root: string;
  server: ServerConfig;
  launch: Launch;
  client: LspClient;
  generation: number;
  docs: Map<string, Document>;
  starting?: Promise<void>;
  restarting?: Promise<void>;
  failures: number;
  lastCrash: number;
  inflight: number;
  lastActive: number;
  observedPush: boolean;
}

/** 共享核心内部状态契约，由同一资源拥有者管理。 */
export interface Workspace {
  root: string;
  router: Router;
  index: WorkspaceIndex;
  files: Map<string, DiskFile>;
  complete: boolean;
  scanned: boolean;
  warnings: string[];
  reconciling?: Promise<void>;
}
