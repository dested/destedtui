// Linux process plumbing, straight from /proc: no ps, no lsof. The Linux
// halves of lib/ports.ts (the scanner) and lib/run.ts (tree kill) sit on this.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface Stat {
  pid: number;
  /** kernel's short name (15 chars max) */
  comm: string;
  state: string;
  ppid: number;
  pgrp: number;
  session: number;
  /** user + system CPU, clock ticks */
  ticks: number;
  /** clock ticks after boot */
  starttime: number;
  /** resident pages */
  rssPages: number;
}

/** USER_HZ. 100 on every mainstream x86_64/arm64 kernel, WSL's included. */
export const CLK_TCK = 100;
export const PAGE = 4096;

export function listPids(): number[] {
  const out: number[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const n of names) {
    const pid = Number(n);
    if (Number.isInteger(pid) && pid > 0) out.push(pid);
  }
  return out;
}

/** One /proc/<pid>/stat, or null when the process is gone. */
export function readStat(pid: number): Stat | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "latin1");
  } catch {
    return null;
  }
  // comm is parenthesised and may itself hold spaces or ')': split after the LAST ')'.
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 2).split(" ");
  // f[0] is field 3 (state); field n lives at f[n - 3].
  const num = (field: number) => Number(f[field - 3] ?? 0);
  return {
    pid,
    comm: text.slice(open + 1, close),
    state: f[0] ?? "?",
    ppid: num(4),
    pgrp: num(5),
    session: num(6),
    ticks: num(14) + num(15),
    starttime: num(22),
    rssPages: num(24),
  };
}

export function readAllStats(): Map<number, Stat> {
  const out = new Map<number, Stat>();
  for (const pid of listPids()) {
    const s = readStat(pid);
    if (s) out.set(pid, s);
  }
  return out;
}

let bootMs: number | null = null;

/** Wall-clock ms of the kernel's boot (`btime` in /proc/stat). */
export function bootTimeMs(): number {
  if (bootMs !== null) return bootMs;
  try {
    const m = /^btime\s+(\d+)/m.exec(readFileSync("/proc/stat", "latin1"));
    bootMs = m?.[1] ? Number(m[1]) * 1000 : 0;
  } catch {
    bootMs = 0;
  }
  return bootMs;
}

/** argv joined back into one line; args with spaces are quoted so a tokenizer can split them again. */
export function readCmdline(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw
      .split("\0")
      .filter((a, i, all) => a !== "" || i < all.length - 1)
      .map((a) => (/\s/.test(a) ? `"${a}"` : a))
      .join(" ")
      .trim();
  } catch {
    return "";
  }
}

export function readLink(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    return "";
  }
}

/** Anonymous resident bytes (RssAnon = resident − shared): the private memory a leak grows. */
export function readPrivate(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/statm`, "latin1").split(" ");
    return Math.max(0, Number(f[1] ?? 0) - Number(f[2] ?? 0)) * PAGE;
  } catch {
    return 0;
  }
}

/**
 * Everything a kill of `root` should take: its descendants by ppid, plus every
 * process in a group or session it leads (a re-parented daemon is still in it).
 */
export function treeOf(root: number, stats = readAllStats()): number[] {
  const children = new Map<number, number[]>();
  for (const s of stats.values()) {
    const list = children.get(s.ppid);
    if (list) list.push(s.pid);
    else children.set(s.ppid, [s.pid]);
  }
  const out = new Set<number>();
  const stack = [root];
  for (const s of stats.values()) if (s.pgrp === root || s.session === root) stack.push(s.pid);
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || out.has(pid)) continue;
    out.add(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  out.delete(process.pid);
  return [...out];
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* gone, or not ours */
  }
}

/**
 * SIGTERM the whole tree now, SIGKILL whatever is left 2s later. The follow-up
 * runs in a detached `sh` so it still lands when the kill came from our own
 * exit handler (timers never fire there).
 */
export function posixTreeKill(pid: number): void {
  const stats = readAllStats();
  const pids = treeOf(pid, stats);
  const leads = stats.get(pid)?.pgrp === pid;
  if (leads) signal(-pid, "SIGTERM");
  for (const p of pids) signal(p, "SIGTERM");
  const targets = [...(leads ? [`-${pid}`] : []), ...pids.map(String)];
  if (targets.length === 0) return;
  try {
    const reaper = Bun.spawn(["/bin/sh", "-c", `sleep 2; kill -9 -- ${targets.join(" ")} 2>/dev/null; exit 0`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    reaper.unref();
  } catch {
    /* no sh: SIGTERM was the best we could do */
  }
}
