// The Linux OsLayer for lib/ports.ts: listeners from /proc/net/tcp{,6}
// (state 0A), socket inode → pid through /proc/<pid>/fd, and each process's
// cmdline, cwd, ppid, start time, CPU and memory from /proc/<pid>. Only the
// current user's processes have readable fds and cwds, which is every dev
// server worth listing.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { Entry, ListenerMap, OsLayer, ProcInfo } from "./ports.ts";
import { bootTimeMs, CLK_TCK, PAGE, readAllStats, readCmdline, readLink, readPrivate, type Stat } from "./proc.linux.ts";

const LISTEN = "0A";

/** `0100007F` (host-order u32 printed as hex) → `127.0.0.1`. */
function ipv4(hex: string): string {
  const n = Number.parseInt(hex, 16);
  return `${n & 0xff}.${(n >>> 8) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 24) & 0xff}`;
}

/** 32 hex chars, four host-order u32 words → normalised IPv6 text. */
function ipv6(hex: string): string {
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    const n = Number.parseInt(hex.slice(w * 8, w * 8 + 8), 16);
    bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }
  // ::ffff:a.b.c.d is an IPv4 address on a dual-stack socket: report the IPv4.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12).join(".");
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  const full = groups.join(":");
  if (full === "0:0:0:0:0:0:0:0") return "::";
  if (full === "0:0:0:0:0:0:0:1") return "::1";
  return full.replace(/(^|:)0(:0)+(:|$)/, "::");
}

/** inode → { port, addr } for every listening TCP socket in this network namespace. */
function listeningInodes(): Map<string, { port: number; addr: string }> {
  const out = new Map<string, { port: number; addr: string }>();
  for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
    let text: string;
    try {
      text = readFileSync(file, "latin1");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] !== LISTEN) continue;
      const [addrHex, portHex] = (f[1] ?? "").split(":");
      const inode = f[9];
      if (!addrHex || !portHex || !inode || inode === "0") continue;
      out.set(inode, { port: Number.parseInt(portHex, 16), addr: v6 ? ipv6(addrHex) : ipv4(addrHex) });
    }
  }
  return out;
}

function listeners(): ListenerMap {
  const out: ListenerMap = new Map();
  const inodes = listeningInodes();
  if (inodes.size === 0) return out;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // another user's process, or gone
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!link.startsWith("socket:[")) continue;
      const hit = inodes.get(link.slice(8, -1));
      if (!hit) continue;
      const n = Number(pid);
      let ports = out.get(n);
      if (!ports) out.set(n, (ports = new Map()));
      let addrs = ports.get(hit.port);
      if (!addrs) ports.set(hit.port, (addrs = new Set()));
      addrs.add(hit.addr);
    }
  }
  return out;
}

/**
 * The name a process is known by. The binary's own name, except where that's
 * a version string: Claude Code's native build lives at
 * `~/.local/share/claude/versions/2.1.296`, so its comm (`claude`) says more.
 */
function exeOf(pid: number, s: Stat): string {
  const link = readLink(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  const base = link.split("/").pop() ?? "";
  if (!base || /^\d+(\.\d+)+/.test(base)) return s.comm;
  return base;
}

const detailCache = new Map<string, { exe: string; cmdline: string; cwd: string }>();

function snapshot(): { entries: Map<number, Entry>; inspect: (e: Entry) => ProcInfo } {
  const stats = readAllStats();
  const boot = bootTimeMs();
  const entries = new Map<number, Entry>();
  for (const s of stats.values()) {
    if (s.ppid === 2 || s.pid === 2) continue; // kernel threads
    const key = `${s.pid}:${s.starttime}`;
    const cached = detailCache.get(key);
    entries.set(s.pid, { pid: s.pid, ppid: s.ppid, exe: cached?.exe ?? exeOf(s.pid, s) });
  }
  const inspect = (e: Entry): ProcInfo => {
    const s = stats.get(e.pid);
    const info: ProcInfo = { pid: e.pid, ppid: e.ppid, exe: e.exe, cmdline: "", cwd: "", startedAt: 0, memory: 0, commit: 0, cpuMs: 0 };
    if (!s) return info;
    info.startedAt = boot ? Math.round(boot + (s.starttime * 1000) / CLK_TCK) : 0;
    info.cpuMs = Math.round((s.ticks * 1000) / CLK_TCK);
    info.memory = s.rssPages * PAGE;
    info.commit = readPrivate(e.pid);
    // Like the Windows PEB read: cmdline/cwd once per pid + start time.
    const key = `${e.pid}:${s.starttime}`;
    let d = detailCache.get(key);
    if (!d) {
      d = { exe: e.exe, cmdline: readCmdline(e.pid), cwd: readLink(`/proc/${e.pid}/cwd`) };
      detailCache.set(key, d);
    }
    info.cmdline = d.cmdline;
    info.cwd = d.cwd;
    return info;
  };
  return { entries, inspect };
}

export const linuxLayer: OsLayer = {
  snapshot,
  listeners,
  skip: (pid) => pid === 1, // init / systemd
  prune(alive) {
    if (detailCache.size <= alive.size * 2) return;
    for (const key of detailCache.keys()) {
      const pid = Number(key.slice(0, key.indexOf(":")));
      if (!alive.has(pid)) detailCache.delete(key);
    }
  },
};
