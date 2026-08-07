import { join } from "node:path";
import type { Subprocess } from "bun";

/**
 * Bun-side client for the Node pty-host sidecar (`ptyhost/host.mjs`). Bun can't
 * drive Windows ConPTY itself, so all real terminals live in a Node child and we
 * talk to it over stdio with line-delimited JSON. One sidecar hosts every pane;
 * killing it frees every terminal at once.
 */

interface HostMsgIn {
  t: "ready" | "data" | "exit" | "spawned";
  id?: string;
  s?: string;
  code?: number;
  pid?: number;
}

export interface SpawnOpts {
  id: string;
  file: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface PtyHostHandlers {
  onData: (id: string, s: string) => void;
  onExit: (id: string, code: number) => void;
  onSpawned?: (id: string, pid: number) => void;
}

const HOST_PATH = join(import.meta.dir, "..", "..", "ptyhost", "host.mjs");

function treeKill(pid: number): void {
  Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
}

export class PtyHost {
  private proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private stdin: Bun.FileSink | null = null;
  private handlers: PtyHostHandlers;
  private ready = false;
  private queue: string[] = [];
  private disposed = false;

  constructor(handlers: PtyHostHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    if (this.proc) return;
    // Hand the sidecar our PID so its watchdog can self-destruct if we die hard.
    const proc = Bun.spawn(["node", HOST_PATH, String(process.pid)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    });
    this.proc = proc;
    this.stdin = proc.stdin;
    this.pump(proc.stdout);
    // Whatever happens to us, take the sidecar (and its ptys) down with us.
    process.on("exit", this.disposeSync);
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: HostMsgIn;
        try {
          msg = JSON.parse(line) as HostMsgIn;
        } catch {
          continue;
        }
        this.dispatch(msg);
      }
    }
  }

  private dispatch(msg: HostMsgIn): void {
    if (msg.t === "ready") {
      this.ready = true;
      for (const q of this.queue) this.stdin?.write(q);
      this.queue = [];
      this.stdin?.flush();
      return;
    }
    if (!msg.id) return;
    if (msg.t === "data" && typeof msg.s === "string") this.handlers.onData(msg.id, msg.s);
    else if (msg.t === "exit") this.handlers.onExit(msg.id, msg.code ?? 0);
    else if (msg.t === "spawned") this.handlers.onSpawned?.(msg.id, msg.pid ?? 0);
  }

  private send(msg: Record<string, unknown>): void {
    const line = JSON.stringify(msg) + "\n";
    if (!this.ready) {
      this.queue.push(line);
      return;
    }
    this.stdin?.write(line);
    this.stdin?.flush();
  }

  spawn(opts: SpawnOpts): void {
    this.send({ t: "spawn", ...opts });
  }

  write(id: string, data: string): void {
    this.send({ t: "write", id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ t: "resize", id, cols, rows });
  }

  kill(id: string): void {
    this.send({ t: "kill", id });
  }

  /** Idempotent, exit-handler-safe teardown. */
  private disposeSync = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      this.stdin?.end();
    } catch {
      /* pipe already closed */
    }
    if (proc.pid) treeKill(proc.pid);
  };

  dispose(): void {
    this.disposeSync();
  }
}
