// PTY host sidecar — runs under Node (NOT Bun): Bun can't drive Windows
// named-pipe socket FDs, so node-pty's writes fail there. Node handles ConPTY
// fine. The Bun TUI spawns this, and we speak line-delimited JSON over stdio.
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

const require = createRequire(import.meta.url);
/** node-pty is CJS with a native binding; load it through require. */
const pty = require("@lydell/node-pty");

/** @type {Map<string, import("@lydell/node-pty").IPty>} */
const ptys = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function killAll() {
  for (const [, p] of ptys) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  ptys.clear();
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
  try {
    spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* taskkill unavailable — killAll already handled the shells */
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
