// Localhost servers: which processes are listening on TCP, and what they are.
//
// Everything comes from Win32 through bun:ffi — the listener table from
// iphlpapi, the process tree from a Toolhelp snapshot, and each process's
// command line + working directory read straight out of its PEB. No netstat,
// no PowerShell: a full scan is a few milliseconds, so the screen can poll.
//
// The PEB offsets below are the x64 layout (also what ARM64 Windows uses for
// 64-bit processes). A 32-bit target would need the WOW64 PEB — node and bun
// are 64-bit, so a failed read just leaves that field empty.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { networkInterfaces } from "node:os";
import { treeKill } from "./run.ts";

export type Runtime = "node" | "bun" | "other";

export interface Listener {
  port: number;
  /** Local bind addresses for this port, normalised ("127.0.0.1", "::1", "0.0.0.0", "::"). */
  addrs: string[];
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  exe: string;
  cmdline: string;
  cwd: string;
  /** ms since epoch, 0 when unreadable */
  startedAt: number;
  /** working set bytes, 0 when unreadable */
  memory: number;
}

export interface Server {
  proc: ProcInfo;
  runtime: Runtime;
  listeners: Listener[];
  /** Ancestors, nearest first (stops at the root of the snapshot). */
  ancestors: ProcInfo[];
  /** What `kill` stops: the top of the dev-command chain this listener belongs to. */
  killRoot: ProcInfo;
  /** Any port bound beyond loopback — reachable from the LAN. */
  exposed: boolean;
  /** How many processes the chain kill takes down (killRoot + every descendant). */
  killCount: number;
  /** Ports of OTHER listed servers living in the same kill tree — they die too. */
  alsoStops: number[];
}

export interface Scan {
  servers: Server[];
  at: number;
  error: string | null;
}

// ─── FFI ──────────────────────────────────────────────────────────────────────

const isWin = process.platform === "win32";

function loadWin32() {
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    ReadProcessMemory: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
    Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const ntdll = dlopen("ntdll.dll", {
    NtQueryInformationProcess: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  const iphlpapi = dlopen("iphlpapi.dll", {
    GetExtendedTcpTable: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.u32,
    },
  });
  return { k: kernel32.symbols, nt: ntdll.symbols, ip: iphlpapi.symbols };
}

type Win32 = ReturnType<typeof loadWin32>;
let win32: Win32 | null = null;
let win32Error: string | null = null;

function api(): Win32 | null {
  if (win32 || win32Error) return win32;
  try {
    win32 = loadWin32();
  } catch (err) {
    win32Error = err instanceof Error ? err.message : String(err);
  }
  return win32;
}

const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_LISTENER = 3;
const ERROR_INSUFFICIENT_BUFFER = 122;
const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;
const PROCESSENTRY32W_SIZE = 568;
/** 100ns ticks between 1601-01-01 and 1970-01-01 */
const FILETIME_EPOCH = 116444736000000000n;

// ─── listeners ────────────────────────────────────────────────────────────────

function tcpTable(w: Win32, family: number): Uint8Array | null {
  const size = new Uint32Array(1);
  let buf = new Uint8Array(16 * 1024);
  for (let attempt = 0; attempt < 4; attempt++) {
    size[0] = buf.byteLength;
    const rc = w.ip.GetExtendedTcpTable(ptr(buf), ptr(size), 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (rc === 0) return buf;
    if (rc !== ERROR_INSUFFICIENT_BUFFER) return null;
    buf = new Uint8Array((size[0] ?? 0) + 4096);
  }
  return null;
}

/** dwLocalPort is network byte order in the low 16 bits. */
function portOf(dw: number): number {
  return ((dw & 0xff) << 8) | ((dw >> 8) & 0xff);
}

function ipv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  const full = groups.join(":");
  if (full === "0:0:0:0:0:0:0:0") return "::";
  if (full === "0:0:0:0:0:0:0:1") return "::1";
  return full.replace(/(^|:)0(:0)+(:|$)/, "::");
}

function listenersByPid(w: Win32): Map<number, Map<number, Set<string>>> {
  const out = new Map<number, Map<number, Set<string>>>();
  const add = (pid: number, port: number, addr: string) => {
    let ports = out.get(pid);
    if (!ports) out.set(pid, (ports = new Map()));
    let addrs = ports.get(port);
    if (!addrs) ports.set(port, (addrs = new Set()));
    addrs.add(addr);
  };

  // MIB_TCPTABLE_OWNER_PID: dwNumEntries, then 6-dword rows
  // (state, localAddr, localPort, remoteAddr, remotePort, owningPid).
  const v4 = tcpTable(w, AF_INET);
  if (v4) {
    const dv = new DataView(v4.buffer);
    const n = dv.getUint32(0, true);
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 24;
      const a = dv.getUint32(o + 4, true);
      const addr = `${a & 0xff}.${(a >> 8) & 0xff}.${(a >> 16) & 0xff}.${(a >>> 24) & 0xff}`;
      add(dv.getUint32(o + 20, true), portOf(dv.getUint32(o + 8, true)), addr);
    }
  }

  // MIB_TCP6ROW_OWNER_PID (56 bytes): localAddr[16], localScopeId, localPort,
  // remoteAddr[16], remoteScopeId, remotePort, state, owningPid.
  const v6 = tcpTable(w, AF_INET6);
  if (v6) {
    const dv = new DataView(v6.buffer);
    const n = dv.getUint32(0, true);
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 56;
      add(dv.getUint32(o + 52, true), portOf(dv.getUint32(o + 20, true)), ipv6(v6.subarray(o, o + 16)));
    }
  }
  return out;
}

// ─── processes ────────────────────────────────────────────────────────────────

interface Entry {
  pid: number;
  ppid: number;
  exe: string;
}

function snapshot(w: Win32): Map<number, Entry> {
  const out = new Map<number, Entry>();
  const snap = w.k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap) return out;
  try {
    const entry = new Uint8Array(PROCESSENTRY32W_SIZE);
    const dv = new DataView(entry.buffer);
    dv.setUint32(0, PROCESSENTRY32W_SIZE, true);
    let ok = w.k.Process32FirstW(snap, ptr(entry));
    while (ok) {
      const nameBytes = entry.subarray(44, 44 + 520);
      const name = new TextDecoder("utf-16le").decode(nameBytes);
      const nul = name.indexOf("\0");
      const pid = dv.getUint32(8, true);
      out.set(pid, { pid, ppid: dv.getUint32(32, true), exe: nul >= 0 ? name.slice(0, nul) : name });
      ok = w.k.Process32NextW(snap, ptr(entry));
    }
  } finally {
    w.k.CloseHandle(snap);
  }
  return out;
}

function readRemote(w: Win32, h: Pointer, addr: bigint, size: number): Uint8Array | null {
  if (addr === 0n || size <= 0) return null;
  const buf = new Uint8Array(size);
  const ok = w.k.ReadProcessMemory(h, addr, ptr(buf), BigInt(size), null);
  return ok ? buf : null;
}

/** A UNICODE_STRING inside the target process: u16 Length @0, PWSTR Buffer @8. */
function readUnicodeString(w: Win32, h: Pointer, header: DataView, offset: number): string {
  const len = header.getUint16(offset, true);
  const bufAddr = header.getBigUint64(offset + 8, true);
  const bytes = readRemote(w, h, bufAddr, len);
  return bytes ? new TextDecoder("utf-16le").decode(bytes) : "";
}

const detailCache = new Map<string, { cmdline: string; cwd: string; startedAt: number }>();

function inspect(w: Win32, e: Entry): ProcInfo {
  const info: ProcInfo = { pid: e.pid, ppid: e.ppid, exe: e.exe, cmdline: "", cwd: "", startedAt: 0, memory: 0 };
  const h =
    w.k.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, e.pid) ??
    w.k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, e.pid);
  if (!h) return info;
  try {
    const times = new BigUint64Array(4);
    if (w.k.GetProcessTimes(h, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24))) {
      const ft = times[0] ?? 0n;
      if (ft > FILETIME_EPOCH) info.startedAt = Number((ft - FILETIME_EPOCH) / 10000n);
    }

    // PROCESS_MEMORY_COUNTERS: WorkingSetSize (SIZE_T) at offset 16, struct is 72 bytes.
    const mem = new Uint8Array(72);
    new DataView(mem.buffer).setUint32(0, 72, true);
    if (w.k.K32GetProcessMemoryInfo(h, ptr(mem), 72)) {
      info.memory = Number(new DataView(mem.buffer).getBigUint64(16, true));
    }

    // cmdline/cwd never change after start (well, cwd can — but dev servers
    // don't chdir), so a pid+start-time key lets us read the PEB once.
    const key = `${e.pid}:${info.startedAt}`;
    const cached = detailCache.get(key);
    if (cached) return { ...info, cmdline: cached.cmdline, cwd: cached.cwd };

    // PROCESS_BASIC_INFORMATION (48 bytes): PebBaseAddress at offset 8.
    const pbi = new Uint8Array(48);
    if (w.nt.NtQueryInformationProcess(h, 0, ptr(pbi), 48, null) !== 0) return info;
    const peb = new DataView(pbi.buffer).getBigUint64(8, true);
    // PEB.ProcessParameters at 0x20.
    const pebHead = readRemote(w, h, peb, 0x28);
    if (!pebHead) return info;
    const params = new DataView(pebHead.buffer).getBigUint64(0x20, true);
    // RTL_USER_PROCESS_PARAMETERS: CurrentDirectory.DosPath @0x38, CommandLine @0x70.
    const paramsHead = readRemote(w, h, params, 0x80);
    if (!paramsHead) return info;
    const pv = new DataView(paramsHead.buffer);
    info.cwd = readUnicodeString(w, h, pv, 0x38).replace(/\\$/, "");
    info.cmdline = readUnicodeString(w, h, pv, 0x70);
    detailCache.set(key, { cmdline: info.cmdline, cwd: info.cwd, startedAt: info.startedAt });
    return info;
  } finally {
    w.k.CloseHandle(h);
  }
}

// ─── classification ───────────────────────────────────────────────────────────

export function runtimeOf(exe: string): Runtime {
  const name = exe.toLowerCase();
  if (name === "node.exe" || name === "node") return "node";
  if (name === "bun.exe" || name === "bun") return "bun";
  return "other";
}

/** Processes a dev command is launched through: runtimes, and the cmd.exe /c that npm/pnpm/yarn wrap scripts in. */
function isLauncher(p: ProcInfo): boolean {
  if (runtimeOf(p.exe) !== "other") return true;
  // `/c` = run-and-exit; an interactive cmd.exe is somebody's terminal, never a target.
  return p.exe.toLowerCase() === "cmd.exe" && /\s\/c\b/i.test(p.cmdline);
}

/**
 * Walk up from the listener while the parent is still part of the same dev
 * command (`bun run dev` → `node vite`), so killing it frees the port for good
 * instead of letting a watcher respawn the child. Never climbs into this tui,
 * its ancestors, an interactive shell, or a claude session.
 */
function findKillRoot(listener: ProcInfo, ancestors: ProcInfo[], protectedPids: Set<number>): ProcInfo {
  let root = listener;
  for (const parent of ancestors) {
    if (protectedPids.has(parent.pid)) break;
    if (!isLauncher(parent)) break;
    if (/claude/i.test(parent.cmdline)) break;
    root = parent;
  }
  return root;
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

// ─── scan ─────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Include every listener, not just node/bun ones. */
  all: boolean;
}

export function scanServers(opts: ScanOptions): Scan {
  const at = Date.now();
  if (!isWin) return { servers: [], at, error: "localhost scanning is Windows-only for now" };
  const w = api();
  if (!w) return { servers: [], at, error: `couldn't load Win32 APIs: ${win32Error ?? "unknown"}` };

  const listening = listenersByPid(w);
  const entries = snapshot(w);
  const infos = new Map<number, ProcInfo>();
  const info = (pid: number): ProcInfo | null => {
    const hit = infos.get(pid);
    if (hit) return hit;
    const e = entries.get(pid);
    if (!e) return null;
    const p = inspect(w, e);
    infos.set(pid, p);
    return p;
  };

  // This tui and everything above it must never be a kill target.
  const protectedPids = new Set<number>([process.pid]);
  for (let cur = entries.get(process.pid); cur && !protectedPids.has(cur.ppid); cur = entries.get(cur.ppid)) {
    protectedPids.add(cur.ppid);
  }

  const servers: Server[] = [];
  for (const [pid, ports] of listening) {
    if (pid === 0 || pid === 4) continue; // idle / System
    const e = entries.get(pid);
    if (!e) continue;
    const runtime = runtimeOf(e.exe);
    if (!opts.all && runtime === "other") continue;
    if (protectedPids.has(pid)) continue;
    const proc = info(pid);
    if (!proc) continue;

    const ancestors: ProcInfo[] = [];
    const seen = new Set<number>([pid]);
    for (let p = info(proc.ppid); p && !seen.has(p.pid); p = info(p.ppid)) {
      // A recycled pid can make a "parent" younger than its child — that's
      // where the real chain ended.
      const child = ancestors[ancestors.length - 1] ?? proc;
      if (p.startedAt && child.startedAt && p.startedAt > child.startedAt) break;
      seen.add(p.pid);
      ancestors.push(p);
      if (ancestors.length > 12) break;
    }

    const listeners: Listener[] = [...ports]
      .map(([port, addrs]) => ({ port, addrs: [...addrs].sort() }))
      .sort((a, b) => a.port - b.port);
    const exposed = listeners.some((l) => l.addrs.some((a) => !LOOPBACK.has(a)));
    const killRoot = runtime === "other" ? proc : findKillRoot(proc, ancestors, protectedPids);
    servers.push({ proc, runtime, listeners, ancestors, killRoot, exposed, killCount: 1, alsoStops: [] });
  }

  const children = new Map<number, number[]>();
  for (const e of entries.values()) {
    const list = children.get(e.ppid);
    if (list) list.push(e.pid);
    else children.set(e.ppid, [e.pid]);
  }
  for (const s of servers) {
    let count = 0;
    const stack = [s.killRoot.pid];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop();
      if (pid === undefined || seen.has(pid)) continue;
      seen.add(pid);
      count++;
      for (const c of children.get(pid) ?? []) stack.push(c);
    }
    s.killCount = count;
    const root = s.killRoot.pid;
    s.alsoStops = servers
      .filter((o) => o !== s && (o.proc.pid === root || o.ancestors.some((a) => a.pid === root)))
      .flatMap((o) => o.listeners.map((l) => l.port));
  }

  servers.sort((a, b) => (a.listeners[0]?.port ?? 0) - (b.listeners[0]?.port ?? 0));
  return { servers, at, error: null };
}

// ─── helpers for the screen ───────────────────────────────────────────────────

export function urlFor(port: number, host = "localhost"): string {
  if (port === 443) return `https://${host}`;
  if (port === 80) return `http://${host}`;
  return `http://${host}:${port}`;
}

/** The first non-internal IPv4 — what a phone on the LAN would type. */
export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal && !ni.address.startsWith("169.254.")) return ni.address;
    }
  }
  return null;
}

export interface Probe {
  /** "http" = answered with headers; "timeout" = accepted the socket but said nothing; "other" = not HTTP at all. */
  kind: "http" | "timeout" | "other";
  status: number | null;
  title: string | null;
}

const PROBE_TIMEOUT_MS = 4000;
const PROBE_RETRY_MS = 15000;

interface ProbeEntry {
  result: Probe | null;
  at: number;
}

const probeCache = new Map<string, ProbeEntry>();

/**
 * One GET per (pid, port), cached: the page <title> is the best one-word answer
 * to "what is this?". A successful probe sticks for the life of the process; a
 * failed one is retried, since a watcher mid-restart looks dead for a second.
 */
export function probe(pid: number, port: number): Probe | null {
  const key = `${pid}:${port}`;
  const hit = probeCache.get(key);
  if (hit && (hit.result === null || hit.result.kind === "http" || Date.now() - hit.at < PROBE_RETRY_MS)) {
    return hit.result ?? null;
  }
  const entry: ProbeEntry = { result: hit?.result ?? null, at: Date.now() };
  probeCache.set(key, entry);
  void runProbe(port).then((r) => {
    entry.result = r;
    entry.at = Date.now();
  });
  return entry.result;
}

/** One uncached GET for the page <title>. The screen goes through `probe`; one-shot callers (--ports --json) await this. */
export async function runProbe(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(urlFor(port), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { accept: "text/html,*/*" },
      // portless and friends serve self-signed certs on 443.
      tls: { rejectUnauthorized: false },
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { kind: timedOut ? "timeout" : "other", status: null, title: null };
  }
  // Headers arrived — it's HTTP whatever happens to the body.
  let title: string | null = null;
  try {
    if ((res.headers.get("content-type") ?? "").includes("html")) {
      const body = await readPrefix(res, 64 * 1024);
      const m = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
      title = m?.[1]?.replace(/\s+/g, " ").trim() || null;
    }
  } catch {
    /* streaming SSR that never ends, or a reset mid-body — the status is enough */
  } finally {
    void res.body?.cancel().catch(() => {});
  }
  return { kind: "http", status: res.status, title };
}

/** Read at most `limit` bytes — an SSR stream may never end. */
async function readPrefix(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (/<\/title>/i.test(text)) break;
  }
  reader.releaseLock();
  return text;
}

/** Tree-kill the chain root (or just the listener). Returns the pid that was killed. */
export function killServer(server: Server, scope: "chain" | "listener"): number {
  const target = scope === "chain" ? server.killRoot : server.proc;
  treeKill(target.pid);
  return target.pid;
}
