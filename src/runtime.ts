import { inspectProcess } from "./process-identity.ts";
import { target } from "./servers.ts";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Core } from "./core.ts";
import { atomicJson } from "./platform.ts";
import { readJson, missing, secureRoot } from "./configuration.ts";

export interface RuntimeRecord {
  instanceId: string;
  pid: number;
  started: string;
  processIdentity: string;
  protocolVersion: 1 | 2;
  endpoint: string;
  token: string;
  workspaces: string[];
  assets: string[];
}

/** 注册表只允许用户独占普通文件，返回内部令牌供本地鉴权，不得直接输出。 */
export async function runtimes(
  root: string,
  signal: AbortSignal,
): Promise<RuntimeRecord[]> {
  const directory = join(root, "runtime");
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const result: RuntimeRecord[] = [];
  for (const name of names) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    const path = join(directory, name);
    const stat = await fs.lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      continue;
    const x = (await readJson(path, null, signal)) as RuntimeRecord;
    if (
      x &&
      (x.protocolVersion === 1 || x.protocolVersion === 2) &&
      typeof x.token === "string" &&
      /^[a-f0-9]{64}$/.test(x.token) &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(x.endpoint) &&
      x.instanceId + ".json" === name &&
      Array.isArray(x.assets) &&
      Number.isSafeInteger(x.pid) &&
      typeof x.processIdentity === "string"
    )
      result.push(x);
  }
  return result;
}

/** 控制请求显式定位实例，令牌只经请求头传输，CLI 输出剥离令牌。 */
export async function control(
  record: RuntimeRecord,
  action: "status" | "restart",
  workspace: string | undefined,
  signal: AbortSignal,
  server?: string,
): Promise<unknown> {
  const selectedServer = server === undefined ? undefined : target(server);
  if (
    action === "restart" &&
    selectedServer !== undefined &&
    record.protocolVersion !== 2
  )
    throw new Error(
      "Unsupported：旧Core控制协议不支持Server定位，请新启动插件连接。",
    );
  if (action === "status" && selectedServer !== undefined)
    throw new Error("InvalidInput：status不接受Server选择。");
  const processState = await inspectProcess(record.pid, signal);
  if (
    processState.state !== "alive" ||
    processState.identity !== record.processIdentity
  )
    throw new Error("StaleInstance：进程启动身份无法核实。");
  const response = await fetch(record.endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + record.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: randomUUID(),
      ...(record.protocolVersion === 2 ? { protocolVersion: 2 } : {}),
      instanceId: record.instanceId,
      action,
      workspace,
      server: selectedServer,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    };
    throw new Error(
      typeof error.error === "string"
        ? "StaleInstance：目标失效或拒绝请求：" + error.error.slice(0, 2000)
        : "StaleInstance：目标失效或拒绝请求。",
    );
  }
  return response.json();
}

/** 仅绑定回环端口，固定动作白名单，断连取消管理工作。 */
export async function startControl(
  root: string,
  core: Core,
  assetNames: string[],
  signal: AbortSignal,
): Promise<{ instanceId: string; close: () => Promise<void> }> {
  await secureRoot(root, signal);
  const token = createHash("sha256")
    .update(randomUUID() + randomUUID())
    .digest("hex");
  const instanceId = randomUUID();
  let endpoint = "";
  const started = new Date().toISOString();
  const ownProcess = await inspectProcess(process.pid, signal);
  if (ownProcess.state !== "alive" || !ownProcess.identity)
    throw new Error("OwnershipError：无法记录本进程身份。");
  const processIdentity = ownProcess.identity;
  const registration = join(root, "runtime", instanceId + ".json");
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const presented = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from("Bearer " + token);
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected) ||
        request.method !== "POST"
      )
        throw new Error("Unauthorized");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 64000) throw new Error("InvalidInput");
      }
      const input = JSON.parse(body);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              "id",
              "instanceId",
              "action",
              "workspace",
              "server",
              "protocolVersion",
            ].includes(key),
        ) ||
        input.instanceId !== instanceId ||
        input.protocolVersion !== 2 ||
        typeof input.id !== "string" ||
        !["status", "restart"].includes(input.action)
      )
        throw new Error("InvalidInput");
      if (input.action === "restart") {
        if (
          typeof input.workspace !== "string" ||
          (input.server !== undefined && typeof input.server !== "string")
        )
          throw new Error("InvalidInput");
        await core.restart(
          input.workspace,
          AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
          input.server,
        );
      } else if (input.workspace !== undefined || input.server !== undefined)
        throw new Error("InvalidInput：status不接受工作区或Server选择。");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          instanceId,
          pid: process.pid,
          started,
          protocolVersion: 2,
          instances: core.status(),
        }),
      );
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("无法分配控制端口。");
  endpoint = "http://127.0.0.1:" + address.port;
  const record: RuntimeRecord = {
    instanceId,
    pid: process.pid,
    started,
    processIdentity,
    protocolVersion: 2,
    endpoint,
    token,
    workspaces: [],
    assets: assetNames,
  };
  await atomicJson(registration, record, signal);
  let writing = Promise.resolve();
  const refresh = setInterval(() => {
    record.workspaces = [
      ...new Set(core.status().map((instance) => instance.workspace)),
    ];
    writing = writing
      .then(() => atomicJson(registration, record, signal))
      .catch(() => {});
  }, 500);
  refresh.unref();
  let closing: Promise<void> | undefined;
  return {
    instanceId,
    close: () =>
      (closing ??= (async () => {
        clearInterval(refresh);
        await writing;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(registration, { force: true });
      })()),
  };
}
