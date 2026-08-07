import type { PackageInfo } from "./discovery.ts";

const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(
  `[${ESC}\\u009b][[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007|(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])`,
  "g",
);

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export interface OutputLine {
  text: string;
  stream: "stdout" | "stderr" | "info";
}

export interface ProcHandle {
  kill: () => void;
  exited: Promise<number>;
  pid: number;
}

const running = new Set<ProcHandle>();

/** Kill everything we started — wired to process exit so no orphans survive. */
export function killAll(): void {
  for (const handle of running) {
    try {
      handle.kill();
    } catch {
      /* already dead */
    }
  }
}

process.on("exit", killAll);

/** Track an externally spawned process so killAll() reaps it on quit. */
export function trackProcess(handle: ProcHandle): () => void {
  running.add(handle);
  return () => running.delete(handle);
}

export function treeKill(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
}

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  kind: "stdout" | "stderr",
  onLine: (line: OutputLine) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) onLine({ text: stripAnsi(line), stream: kind });
  }
  if (buffer) onLine({ text: stripAnsi(buffer), stream: kind });
}

/** Run a package.json script with the package's own package manager, streaming output lines. */
export function runScript(pkg: PackageInfo, scriptName: string, onLine: (line: OutputLine) => void): ProcHandle {
  return runCommand(`${pkg.pm} run ${scriptName}`, pkg.dir, onLine);
}

/**
 * Run an arbitrary shell command in a directory, streaming output lines. Same
 * lifecycle as runScript (tracked in `running`, tree-killed on quit) — this is
 * the engine behind the startup dashboard's long-lived dev servers.
 */
export function runCommand(command: string, cwd: string, onLine: (line: OutputLine) => void): ProcHandle {
  const cmd =
    process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command];
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const stdoutDone = pumpLines(proc.stdout, "stdout", onLine);
  const stderrDone = pumpLines(proc.stderr, "stderr", onLine);

  let killed = false;
  let handle!: ProcHandle;
  const exited = (async () => {
    const code = await proc.exited;
    await Promise.allSettled([stdoutDone, stderrDone]);
    running.delete(handle);
    return code;
  })();
  handle = {
    pid: proc.pid,
    kill: () => {
      if (killed) return;
      killed = true;
      treeKill(proc.pid);
    },
    exited,
  };
  running.add(handle);
  return handle;
}

export interface ToolResult {
  code: number;
  stderrTail: string[];
}

/** Run a CLI tool (pg_dump/pg_restore) to completion, keeping the tail of stderr for error reporting. */
export function runTool(
  cmd: string[],
  env: Record<string, string | undefined>,
  onStderrLine?: (line: string) => void,
): { handle: ProcHandle; result: Promise<ToolResult> } {
  const proc = Bun.spawn(cmd, {
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...env },
  });
  const tail: string[] = [];
  const stderrDone = pumpLines(proc.stderr, "stderr", (line) => {
    if (line.text.trim()) {
      tail.push(line.text);
      if (tail.length > 40) tail.shift();
      onStderrLine?.(line.text);
    }
  });

  let killed = false;
  const handle: ProcHandle = {
    pid: proc.pid,
    kill: () => {
      if (killed) return;
      killed = true;
      treeKill(proc.pid);
    },
    exited: proc.exited,
  };
  running.add(handle);
  const result = (async () => {
    const code = await proc.exited;
    await stderrDone.catch(() => {});
    running.delete(handle);
    return { code, stderrTail: tail };
  })();
  return { handle, result };
}

/**
 * Open a URL in Chrome (fire-and-forget, never tracked — we don't want to kill
 * the browser when the tui exits). `start chrome` resolves via Windows' App
 * Paths registry; the empty "" is the mandatory window-title arg to `start`.
 */
export function openInChrome(url: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", "start", "", "chrome", url]
      : process.platform === "darwin"
        ? ["open", "-a", "Google Chrome", url]
        : ["google-chrome", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    /* no chrome — nothing we can do from a tui */
  }
}
