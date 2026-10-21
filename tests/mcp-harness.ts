import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
/** 测试协议驱动集中处理提前退出、取消和有界收尾，不能把悬空等待算测试通过。 */
export class McpHarness {
  readonly exit: Promise<number | null>;
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private ended = false;
  private stderr = "";
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    const fail = (error: Error) => {
      this.ended = true;
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    this.exit = new Promise((resolve) =>
      child.once("close", (code) => {
        fail(
          new Error(`MCP提前关闭，退出码=${code}：${this.stderr.slice(-3000)}`),
        );
        resolve(code);
      }),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const value = JSON.parse(line);
        this.pending.get(value.id)?.resolve(value);
        this.pending.delete(value.id);
      } catch (error) {
        fail(new Error("MCP输出畸形JSON：" + String(error)));
      }
    });
  }
  /** 每个请求受调用者取消和超时约束，退出时立即失败。 */
  async request(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<any> {
    signal.throwIfAborted();
    if (this.ended) throw new Error("MCP已关闭：" + this.stderr.slice(-3000));
    const id = ++this.sequence;
    let abort: () => void = () => {};
    try {
      return await new Promise((resolve, reject) => {
        abort = () => {
          this.pending.delete(id);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        this.pending.set(id, { resolve, reject });
        this.child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          (error) => {
            if (error) {
              this.pending.delete(id);
              reject(error);
            }
          },
        );
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  /** 退出Promise在创建时绑定，子进程已经退出也不能漏掉事件。 */
  async close(signal: AbortSignal): Promise<number | null> {
    const abort = () => {
      this.child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      else if (!this.ended) this.child.stdin.end();
      return await this.exit;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
