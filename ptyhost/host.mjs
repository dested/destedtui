// PTY host sidecar — runs under Node (NOT Bun): Bun can't drive Windows
// named-pipe socket FDs, so node-pty's writes fail there. Node handles ConPTY
// fine. The Bun TUI spawns this, and we speak line-delimited JSON over stdio.
// Linux (WSL) keeps the same sidecar on purpose: one code path, not two.
//
// TUI → host:  {t:"spawn",id,file,args,cwd,cols,rows,env?}
//              {t:"write",id,data}   {t:"resize",id,cols,rows}   {t:"kill",id}
// host → TUI:  {t:"ready"}  {t:"data",id,s}  {t:"exit",id,code}  {t:"spawned",id,pid}
//
// Every pty is tracked; losing stdin (parent gone) kills them all, so nothing
// is ever orphaned.

import { createRequire } from "node:module";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
/** node-pty is CJS with a native binding; load it through require. */
const pty = require("@lydell/node-pty");

/** @type {Map<string, import("@lydell/node-pty").IPty>} */
const ptys = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const isWin = process.platform === "win32";

/**
 * POSIX: everything under these shells, gone. Each pty shell leads its own
 * session (node-pty setsid()s it), and a job it backgrounded is its own process
 * group in that session, so a plain p.kill() (SIGHUP to the shell) can leave
 * `nohup`/disowned jobs behind. Take every process in each session plus every
 * descendant: SIGHUP, a 300ms grace, then SIGKILL whatever is left.
 * @param {number[]} roots
 */
function killTrees(roots) {
  if (roots.length === 0) return;
  /** @type {{pid: number, ppid: number, session: number}[]} */
  const procs = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = readFileSync(`/proc/${name}/stat`, "latin1");
      const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
      procs.push({ pid: Number(name), ppid: Number(f[1]), session: Number(f[3]) });
    } catch {
      /* gone */
    }
  }
  const doomed = new Set();
  const stack = [...roots];
  for (const p of procs) if (roots.includes(p.session)) stack.push(p.pid);
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || doomed.has(pid) || pid === process.pid) continue;
    doomed.add(pid);
    for (const p of procs) if (p.ppid === pid) stack.push(p.pid);
  }
  const hit = (/** @type {NodeJS.Signals} */ sig) => {
    for (const pid of doomed) {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };
  hit("SIGHUP");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  hit("SIGKILL");
}

function killAll() {
  const roots = [...ptys.values()].map((p) => p.pid);
  for (const [, p] of ptys) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  ptys.clear();
  if (!isWin) killTrees(roots);
}

function spawn(m) {
  const proc = pty.spawn(m.file, m.args ?? [], {
    name: "xterm-256color",
    cols: m.cols ?? 80,
    rows: m.rows ?? 24,
    cwd: m.cwd || process.cwd(),
    env: { ...process.env, ...(m.env ?? {}) },
  });
  ptys.set(m.id, proc);
  send({ t: "spawned", id: m.id, pid: proc.pid });
  proc.onData((s) => send({ t: "data", id: m.id, s }));
  proc.onExit(({ exitCode }) => {
    ptys.delete(m.id);
    send({ t: "exit", id: m.id, code: exitCode });
  });
}

function handle(m) {
  switch (m.t) {
    case "spawn":
      spawn(m);
      return;
    case "write": {
      const p = ptys.get(m.id);
      if (p) {
        try {
          p.write(m.data);
        } catch {
          /* raced with exit */
        }
      }
      return;
    }
    case "resize": {
      const p = ptys.get(m.id);
      if (p) {
        try {
          p.resize(Math.max(1, m.cols | 0), Math.max(1, m.rows | 0));
        } catch {
          /* raced with exit */
        }
      }
      return;
    }
    case "kill": {
      const p = ptys.get(m.id);
      if (p) {
        try {
          p.kill();
        } catch {
          /* already gone */
        }
        ptys.delete(m.id);
        if (!isWin) killTrees([p.pid]);
      }
      return;
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch {
    /* ignore malformed frames */
  }
});

function shutdown() {
  killAll();
  // pty.kill() reaps the shell, but a profile can spawn grandchildren and there's
  // always a conhost — tree-kill our own process so NOTHING outlives us, then go.
  // (POSIX: killAll already took each shell's whole session.)
  if (isWin) {
    try {
      spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* taskkill unavailable — killAll already handled the shells */
    }
  }
  process.exit(0);
}

// Parent gone or told to stop → tear everything down.
rl.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", killAll);

// Watchdog: stdin-EOF isn't reliable when the Bun parent is killed hard on
// Windows (the pipe write-end doesn't always close). So poll the parent PID we
// were handed and self-destruct the moment it's gone — nothing outlives the TUI.
const parentPid = Number(process.argv[2]);
if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0); // signal 0 = existence check; throws if gone
    } catch (e) {
      if (e && e.code === "EPERM") return; // exists, just not signalable
      shutdown();
    }
  }, 1500).unref?.();
}

send({ t: "ready" });
