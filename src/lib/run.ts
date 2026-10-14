import { existsSync } from "node:fs";
import type { PackageInfo } from "./discovery.ts";
import { IS_WIN, isWsl } from "./platform.ts";
import { posixTreeKill } from "./proc.linux.ts";

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

/** Windows Chrome as WSL sees it. */
const WSL_CHROME = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";

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

/** How many children are alive right now — any of them holds the TUI awake (lib/idle.ts). */
export function runningCount(): number {
  return running.size;
}

/** Track an externally spawned process so killAll() reaps it on quit. */
export function trackProcess(handle: ProcHandle): () => void {
  running.add(handle);
  return () => running.delete(handle);
}

/**
 * Kill a process and everything under it. Windows: `taskkill /T /F`. POSIX:
 * SIGTERM to its process group and every descendant, SIGKILL 2s later
 * (`posixTreeKill`). Children we start are their own group (`detached`).
 */
export function treeKill(pid: number): void {
  if (IS_WIN) {
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } else {
    posixTreeKill(pid);
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
  const cmd = IS_WIN ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command];
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    // POSIX: its own process group, so a kill takes the whole command with it.
    detached: !IS_WIN,
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
    detached: !IS_WIN,
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
 * In WSL it's the same Windows Chrome, through interop.
 */
export function openInChrome(url: string): void {
  const cmd = IS_WIN
    ? ["cmd.exe", "/d", "/s", "/c", "start", "", "chrome", url]
    : process.platform === "darwin"
      ? ["open", "-a", "Google Chrome", url]
      : isWsl() && existsSync(WSL_CHROME)
        ? [WSL_CHROME, url]
        : ["google-chrome", url];
  try {
    // Detached on POSIX: the interop relay for a fresh Chrome lives as long as Chrome does.
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: !IS_WIN }).unref();
  } catch {
    /* no chrome — nothing we can do from a tui */
  }
}
