import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const output = resolve(
  process.env.CODEX_LSP_EVIDENCE ?? ".artifacts/native-thread",
);
const cli = process.env.CODEX_LSP_PLUGIN_CLI;
if (!cli || !isAbsolute(cli))
  throw new Error(
    "须显式提供已安装插件CLI绝对路径CODEX_LSP_PLUGIN_CLI，不从开发目录冒充安装。",
  );
await fs.stat(cli);
const workspace = join(output, "workspace"),
  data = join(output, "data");
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(join(workspace, "main.c"), "int main(void) { return 0; }\n");
const server = join(output, "delayed-server.mjs");
const fake = fileURLToPath(new URL("../test/fake-server.mjs", import.meta.url));
await fs.writeFile(
  server,
  (await fs.readFile(fake, "utf8")).replace(
    "if (S.publishVersion !== undefined) params.version = S.publishVersion;",
    "params.version = doc?.version;",
  ),
);
for (const args of [
  ["authorize", "--workspace", workspace],
  [
    "configure",
    "clangd",
    "--json",
    JSON.stringify({
      command: process.execPath,
      args: [server],
      env: {
        FAKE_LSP: JSON.stringify({
          log: join(output, "server.jsonl"),
          diagnostics: "push",
          publishDelayMs: 4500,
        }),
      },
    }),
  ],
])
  execFileSync(process.execPath, [cli, ...args, "--data-root", data], {
    timeout: 10000,
    stdio: "pipe",
  });
const childTask = `你是产品测试中的唯一原生子线程，先只读检索实际工具表，输出名称包含codex-lsp、codex_lsp或diagnostics_的工具名称与数量，不调用任何MCP工具，然后只执行一次apply_patch，文件绝对路径${join(workspace, "main.c")}，完整旧行int main(void) { return 0; }替换为int main(void) { return ERROR; }。除上述只读工具表查询与一次补丁，不调用其他工具或MCP，不得修复错误，立即结束；若SubagentStop自动带来新诊断则逐字引用并结束。`;
const mode = process.env.CODEX_LSP_NATIVE_MODE ?? "v1";
if (!["v1", "v2", "v2-direct"].includes(mode))
  throw new Error("原生探针模式仅允许v1或v2。");
const namespace = mode !== "v1" ? "native_thread_probe" : "multi_agent_v1";
const prompt = `这是固定客户端原生ThreadSpawn产品测试，不是实施任务派生。先报告直接工具表中${namespace}命名空间的真实工具名及参数形状，直接调用该命名空间暴露的spawn_agent，不要通过exec调用协作工具，也不要改用collaboration命名空间。若直接工具未暴露就停止并报告。V2原生工具返回task_name而非agent_id，/root任务名本身不表示合成代理，后台原生线程UUID和SubagentStop由测试驱动据协议另行核实。spawn_agent必须显式设置fork_turns为none，不覆盖model。只创建一个子线程，任务为：${childTask}。父线程不得编辑或主动查询诊断，用当前真实原生等待工具等子任务结束并报告最终答复，然后仅用当前实际存在的原生关闭或中断工具结束子线程，禁止创建更多线程。`;
const args = [
  "exec",
  "--json",
  "--strict-config",
  "--skip-git-repo-check",
  "-C",
  workspace,
  "-m",
  "gpt-6.1-sol",
  "--enable",
  "multi_agent",
  ...(mode !== "v1"
    ? [
        "-c",
        'features.multi_agent_v2={enabled=true,disable_native_tools=false,tool_namespace="native_thread_probe",hide_spawn_agent_metadata=false,non_code_mode_only=true,wait_agent_enabled=true}',
      ]
    : ["--disable", "multi_agent_v2"]),
  "--disable",
  "code_mode",
  "-c",
  "agents.enabled=true",
  "-c",
  'model_reasoning_effort="medium"',
  prompt,
];
await fs.writeFile(
  join(output, "invocation.json"),
  JSON.stringify(
    {
      cli,
      args,
      installedBuild: JSON.parse(
        await fs.readFile(join(resolve(cli, ".."), "build-info.json"), "utf8"),
      ),
    },
    null,
    2,
  ),
);
const started = Date.now(),
  child = spawn("codex", args, {
    env: { ...process.env, CODEX_LSP_DATA_HOME: data, CODEX_LSP_TRACE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
let stdout = "",
  stderr = "";
child.stdout.on("data", (value) => (stdout += value));
child.stderr.on("data", (value) => (stderr += value));
const soft = setTimeout(() => child.kill("SIGTERM"), 180000),
  hard = setTimeout(() => child.kill("SIGKILL"), 190000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(soft);
clearTimeout(hard);
await fs.writeFile(join(output, "agent.jsonl"), stdout);
await fs.writeFile(join(output, "agent.stderr"), stderr);
const parentId = stdout.split("\n").flatMap((line) => {
  try {
    const value = JSON.parse(line);
    return value.type === "thread.started" ? [value.thread_id] : [];
  } catch {
    return [];
  }
})[0];
const sessions = [];
const days = [
  ...new Set(
    [started, Date.now()].map((time) => {
      const date = new Date(time);
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("/");
    }),
  ),
];
for (const day of days) {
  const directory = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "sessions",
    day,
  );
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(directory, name),
      stat = await fs.stat(path);
    if (stat.mtimeMs < started) continue;
    const handle = await fs.open(path, "r");
    let metadata;
    try {
      const buffer = Buffer.alloc(256000);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end < 0) continue;
      metadata = JSON.parse(buffer.subarray(0, end).toString()).payload;
    } finally {
      await handle.close();
    }
    if (metadata?.cwd !== workspace) continue;
    const calls = (await fs.readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter(
        (value) =>
          value.type === "response_item" &&
          ["function_call", "custom_tool_call"].includes(value.payload?.type),
      )
      .map((value) => {
        const p = value.payload;
        let args;
        try {
          args = JSON.parse(p.arguments ?? "{}");
          delete args.message;
        } catch {}
        return { name: p.name, namespace: p.namespace, arguments: args };
      });
    sessions.push({
      id: metadata.id,
      sessionId: metadata.session_id,
      source: metadata.source,
      threadSource: metadata.thread_source,
      cliVersion: metadata.cli_version,
      calls,
    });
  }
}
let audit = [];
try {
  audit = (await fs.readFile(join(data, "logs/protocol.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((value) => value.event === "hook");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const children = sessions.filter(
  (value) =>
    value.source?.subagent?.thread_spawn?.parent_thread_id === parentId,
);
const threadEvidence = {
  parentId,
  sessions,
  children: children.map((value) => ({
    id: value.id,
    hooks: audit.filter((event) => event.threadId === value.id),
  })),
  parentHooks: audit.filter((event) => event.threadId === parentId),
  nativeThreadSpawnObserved: children.length > 0,
  subagentStopObserved: children.some((value) =>
    audit.some(
      (event) =>
        event.threadId === value.id &&
        event.hook === "diagnostics_before_subagent_stop",
    ),
  ),
};
await fs.writeFile(
  join(output, "thread-evidence.json"),
  JSON.stringify(threadEvidence, null, 2) + "\n",
);
await fs.writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      pid: child.pid,
      started,
      ended: Date.now(),
      exit,
      finalFile: await fs.readFile(join(workspace, "main.c"), "utf8"),
      scope:
        "开发探针，以session_meta的ThreadSpawn来源与实际子Hook元数据判定，不能单凭/root路径或空wait列表推断。",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ pid: child.pid, ...exit, elapsedMs: Date.now() - started }),
);
