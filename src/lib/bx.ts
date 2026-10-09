// bx daemons: every browser-automation daemon from G:\code\bx (one per
// profile, each holding its own Chrome), what it's doing and what it costs.
// Read by the bx screen (screens/Bx.tsx).
//
// One scan every 2s, three sources:
//   - ~/.bx/run/<profile>.json   run files: pid, port, token
//   - GET /debug on each daemon  its journal (in flight, recent, who's driving),
//                                node heap, Chrome's own per-page counters. The
//                                contract is "Debug surface" in
//                                G:\code\bx\src\protocol.ts — additive only, so
//                                DebugSchema below is the typed boundary and
//                                ignores fields it doesn't know
//   - processTable() (ports.ts)  the daemon's node process and its Chrome tree:
//                                working set, private commit, cpu
// Anything bx-shaped without a live run file is an orphan: a daemon whose run
// file is gone, a Chrome on a bx profile whose daemon died, a run file whose
// process is gone.
//
// A leak is a slope, not a number, so every scan feeds in-memory history (30
// min per series) for sparklines and growth rates. The memlog appends each scan
// to ~/.destedtui/bx-memlog/<date>.jsonl for overnight runs.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { processTable, type ProcInfo } from "./ports.ts";
import { sessionById } from "./procs.ts";
import { leaf } from "./proctext.ts";
import { stripAnsi } from "./run.ts";

const BX_DIR = join(homedir(), ".bx");
const RUN_DIR = join(BX_DIR, "run");
const LOGS_DIR = join(BX_DIR, "logs");
const MEMLOG_DIR = join(homedir(), ".destedtui", "bx-memlog");

const DEBUG_TIMEOUT_MS = 1500;
export const HISTORY_MS = 30 * 60_000;
export const GROWTH_MS = 5 * 60_000;
/** A slope needs at least this much history before it means anything. */
const GROWTH_MIN_SPAN_MS = 60_000;

// ─── the daemon's contract (bx protocol.ts "Debug surface") ──────────────────

const RunFileSchema = z.object({
  profile: z.string(),
  pid: z.number(),
  port: z.number(),
  token: z.string(),
  headless: z.boolean(),
  startedAt: z.string(),
});
export type RunFile = z.infer<typeof RunFileSchema>;

const CmdSchema = z.object({
  id: z.number(),
  cmd: z.string(),
  summary: z.string(),
  tab: z.number().optional(),
  client: z.string().optional(),
  startedAt: z.number(),
});
const CmdDoneSchema = CmdSchema.extend({ ms: z.number(), ok: z.boolean(), error: z.string().optional() });
const ClientSchema = z.object({
  key: z.string(),
  session: z.string().optional(),
  cwd: z.string().optional(),
  pid: z.number().optional(),
  via: z.string().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  commands: z.number(),
});
const MetricsSchema = z.object({
  jsHeapUsed: z.number(),
  jsHeapTotal: z.number(),
  nodes: z.number(),
  documents: z.number(),
  listeners: z.number(),
  frames: z.number(),
  layoutCount: z.number(),
  scriptMs: z.number(),
  taskMs: z.number(),
});
const PageSchema = z.object({
  tab: z.number(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  metrics: MetricsSchema.nullable(),
  refs: z.number(),
});
const DebugSchema = z.object({
  v: z.number(),
  profile: z.string(),
  pid: z.number(),
  headless: z.boolean(),
  startedAt: z.number(),
  uptimeMs: z.number(),
  node: z.object({
    version: z.string(),
    rss: z.number(),
    heapUsed: z.number(),
    heapTotal: z.number(),
    external: z.number(),
    arrayBuffers: z.number(),
    cpuUserMs: z.number(),
    cpuSystemMs: z.number(),
    loopDelayMs: z.object({ mean: z.number(), p99: z.number(), max: z.number() }),
    gcExposed: z.boolean(),
  }),
  browserRunning: z.boolean(),
  recording: z.string().nullable(),
  idle: z.object({ lastActivityAt: z.number(), limitMs: z.number() }),
  inFlight: z.array(CmdSchema),
  recent: z.array(CmdDoneSchema),
  totals: z.object({
    commands: z.number(),
    errors: z.number(),
    byCmd: z.record(z.string(), z.object({ n: z.number(), errors: z.number(), ms: z.number() })),
  }),
  clients: z.array(ClientSchema),
  internals: z.object({
    actionLog: z.number(),
    actionLogChars: z.number(),
    /** absent on daemons from before the cap (their log is never trimmed) */
    actionLogDropped: z.number().optional(),
    actionLogCap: z.number().optional(),
    refPages: z.number(),
    refEntries: z.number(),
    consolePushed: z.number(),
    netPushed: z.number(),
    ringCap: z.number(),
  }),
  pages: z.array(PageSchema),
});
export type Debug = z.infer<typeof DebugSchema>;
export type DebugCmd = z.infer<typeof CmdSchema>;
export type DebugCmdDone = z.infer<typeof CmdDoneSchema>;
export type DebugPage = z.infer<typeof PageSchema>;

const ErrorEnvelope = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });
const envelope = <T extends z.ZodType>(data: T) => z.union([z.object({ ok: z.literal(true), data }), ErrorEnvelope]);
const DebugEnvelope = envelope(DebugSchema);
const GcEnvelope = envelope(z.object({ ran: z.boolean(), heapBefore: z.number(), heapAfter: z.number() }));
const SnapshotEnvelope = envelope(z.object({ path: z.string(), bytes: z.number(), ms: z.number() }));

// ─── history ──────────────────────────────────────────────────────────────────

/** One metric over time, trimmed to HISTORY_MS. */
export class Series {
  readonly t: number[] = [];
  readonly v: number[] = [];

  push(t: number, v: number): void {
    this.t.push(t);
    this.v.push(v);
    let drop = 0;
    while (drop < this.t.length && (this.t[drop] ?? t) < t - HISTORY_MS) drop++;
    if (drop > 0) {
      this.t.splice(0, drop);
      this.v.splice(0, drop);
    }
  }

  last(): number | null {
    return this.v.length ? (this.v[this.v.length - 1] ?? null) : null;
  }

  /** Least-squares slope over the last `windowMs`, in units per minute; null until there's a minute of history. */
  slopePerMin(windowMs = GROWTH_MS): number | null {
    const end = this.t[this.t.length - 1];
    if (end === undefined) return null;
    let i = this.t.length - 1;
    while (i > 0 && (this.t[i - 1] ?? 0) >= end - windowMs) i--;
    const start = this.t[i] ?? end;
    const n = this.t.length - i;
    if (n < 5 || end - start < GROWTH_MIN_SPAN_MS) return null;
    let st = 0;
    let sv = 0;
    for (let k = i; k < this.t.length; k++) {
      st += (this.t[k] ?? 0) - start;
      sv += this.v[k] ?? 0;
    }
    const mt = st / n;
    const mv = sv / n;
    let num = 0;
    let den = 0;
    for (let k = i; k < this.t.length; k++) {
      const dt = (this.t[k] ?? 0) - start - mt;
      num += dt * ((this.v[k] ?? 0) - mv);
      den += dt * dt;
    }
    return den > 0 ? (num / den) * 60_000 : null;
  }

  /** Averages over `n` equal buckets ending at `now`; null where nothing was sampled. */
  buckets(n: number, windowMs: number, now: number): (number | null)[] {
    const sums = new Array<number>(n).fill(0);
    const counts = new Array<number>(n).fill(0);
    const from = now - windowMs;
    for (let k = 0; k < this.t.length; k++) {
      const t = this.t[k] ?? 0;
      if (t < from) continue;
      const b = Math.min(n - 1, Math.floor(((t - from) / windowMs) * n));
      sums[b] = (sums[b] ?? 0) + (this.v[k] ?? 0);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    return sums.map((s, b) => ((counts[b] ?? 0) > 0 ? s / (counts[b] ?? 1) : null));
  }
}

const BARS = "▁▂▃▄▅▆▇█";

/**
 * Min-max scaled, because memory lives far from zero and a zero-based bar
 * would read flat. Under 1% of movement is drawn flat on purpose, so noise
 * never looks like a trend. Missing buckets are a dim dot.
 */
export function sparkline(values: (number | null)[]): string {
  const seen = values.filter((v): v is number => v !== null);
  if (seen.length === 0) return values.map(() => "·").join("");
  const min = Math.min(...seen);
  const max = Math.max(...seen);
  const flat = max <= 0 || (max - min) / max < 0.01;
  return values
    .map((v) => {
      if (v === null) return "·";
      if (flat) return BARS[0] ?? "▁";
      return BARS[Math.min(BARS.length - 1, Math.round(((v - min) / (max - min)) * (BARS.length - 1)))] ?? "▁";
    })
    .join("");
}

export interface PageHistory {
  heap: Series;
  nodes: Series;
  listeners: Series;
}

export interface DaemonHistory {
  /** node commit + chrome commit — the number a leak grows */
  commit: Series;
  ws: Series;
  nodeRss: Series;
  nodeHeap: Series;
  chromeCommit: Series;
  chromeWs: Series;
  pages: Map<number, PageHistory>;
}

function newHistory(): DaemonHistory {
  return {
    commit: new Series(),
    ws: new Series(),
    nodeRss: new Series(),
    nodeHeap: new Series(),
    chromeCommit: new Series(),
    chromeWs: new Series(),
    pages: new Map(),
  };
}

// ─── scan types ───────────────────────────────────────────────────────────────

export type ChromeKind = "browser" | "renderer" | "extension" | "gpu" | "network" | "storage" | "audio" | "utility" | "crashpad" | "node" | "other";

export interface TreeProc {
  proc: ProcInfo;
  kind: ChromeKind;
  depth: number;
  /** cores */
  cpu: number;
}

/**
 * Why there's no fresh /debug: `old` = the daemon predates the endpoint
 * (restart it), `busy` = it didn't answer in time (a heap snapshot or a stuck
 * command), `down` = nothing is listening, `bad` = the answer didn't parse.
 */
export type DebugError = "old" | "busy" | "down" | "bad";

export interface Daemon {
  /** profile:pid — history resets when a profile's daemon restarts */
  key: string;
  profile: string;
  run: RunFile;
  runPath: string;
  node: ProcInfo | null;
  /** the node daemon first, then its Chrome tree (depth-first) */
  tree: TreeProc[];
  /** the last good /debug, kept through a slow read */
  debug: Debug | null;
  debugAt: number;
  debugError: DebugError | null;
  cpu: { node: number; chrome: number };
  mem: { nodeWs: number; nodeCommit: number; chromeWs: number; chromeCommit: number; chromeProcs: number };
  hist: DaemonHistory;
}

export type OrphanKind = "daemon" | "chrome" | "runfile";

export interface Orphan {
  key: string;
  kind: OrphanKind;
  profile: string;
  /** null for a stale run file */
  root: ProcInfo | null;
  tree: TreeProc[];
  memory: number;
  commit: number;
  cpu: number;
  /** the run file to clear (stale run files only) */
  runPath: string | null;
}

export interface BxScan {
  daemons: Daemon[];
  orphans: Orphan[];
  at: number;
  error: string | null;
  totals: { chromeProcs: number; ws: number; commit: number; cpu: number };
  /** commit of everything bx (daemons + orphans), over time */
  hist: Series;
}

// ─── classification ───────────────────────────────────────────────────────────

const isChrome = (p: ProcInfo) => /^chrome(\.exe)?$/i.test(p.exe);
const isNode = (p: ProcInfo) => /^node(\.exe)?$/i.test(p.exe);
const DAEMON_CMD = /daemon[\\/]daemon\.ts/i;
const BX_PROFILE_DIR = /[\\/]\.bx[\\/]profiles[\\/]([^\\/"]+)/i;

export function chromeKind(p: ProcInfo): ChromeKind {
  if (isNode(p)) return "node";
  if (!isChrome(p)) return "other";
  const type = /--type=([\w-]+)/.exec(p.cmdline)?.[1];
  if (!type) return "browser";
  if (type === "renderer") return p.cmdline.includes("--extension-process") ? "extension" : "renderer";
  if (type === "gpu-process") return "gpu";
  if (type === "crashpad-handler") return "crashpad";
  if (type === "utility") {
    const sub = /--utility-sub-type=([\w.]+)/.exec(p.cmdline)?.[1] ?? "";
    if (sub.startsWith("network.")) return "network";
    if (sub.startsWith("storage.")) return "storage";
    if (sub.startsWith("audio.")) return "audio";
    return "utility";
  }
  return "other";
}

/** A bx Chrome's profile, from its --user-data-dir; null when it isn't a bx profile. */
function bxProfileOf(p: ProcInfo): string | null {
  const dir = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(p.cmdline);
  const path = dir?.[1] ?? dir?.[2];
  return path ? (BX_PROFILE_DIR.exec(path)?.[1] ?? null) : null;
}

function daemonProfileOf(p: ProcInfo): string | null {
  if (!isNode(p) || !DAEMON_CMD.test(p.cmdline)) return null;
  return /--profile\s+"?([^"\s]+)/.exec(p.cmdline)?.[1] ?? "default";
}

function readRunFiles(): { run: RunFile; path: string }[] {
  if (!existsSync(RUN_DIR)) return [];
  const out: { run: RunFile; path: string }[] = [];
  for (const f of readdirSync(RUN_DIR)) {
    if (!f.endsWith(".json")) continue;
    const path = join(RUN_DIR, f);
    try {
      const parsed = RunFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) out.push({ run: parsed.data, path });
    } catch {
      // half-written by a daemon booting right now; next scan
    }
  }
  return out;
}

async function fetchDebug(run: RunFile): Promise<{ debug: Debug } | { error: DebugError }> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${run.port}/debug`, {
      headers: { "x-bx-token": run.token },
      signal: AbortSignal.timeout(DEBUG_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: err instanceof Error && err.name === "TimeoutError" ? "busy" : "down" };
  }
  if (res.status === 404) return { error: "old" };
  try {
    const parsed = DebugEnvelope.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { error: "bad" };
    return { debug: parsed.data.data };
  } catch {
    return { error: "bad" };
  }
}

// ─── the sampler ──────────────────────────────────────────────────────────────

interface Last {
  debug: Debug | null;
  at: number;
}

export class BxSampler {
  private prevCpu = new Map<string, { cpuMs: number; at: number }>();
  private readonly hist = new Map<string, DaemonHistory>();
  private readonly lastDebug = new Map<string, Last>();
  private readonly total = new Series();
  private memlogPath: string | null = null;
  private running: Promise<BxScan> | null = null;

  get logging(): string | null {
    return this.memlogPath;
  }

  /** Start/stop appending every scan to ~/.destedtui/bx-memlog/<date>.jsonl. Returns the file, or null when off. */
  setLogging(on: boolean): string | null {
    if (!on) {
      this.memlogPath = null;
      return null;
    }
    mkdirSync(MEMLOG_DIR, { recursive: true });
    this.memlogPath = join(MEMLOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    return this.memlogPath;
  }

  /** Overlapping calls share one scan — a slow /debug must not stack scans up. */
  scan(): Promise<BxScan> {
    if (!this.running) {
      this.running = this.doScan().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doScan(): Promise<BxScan> {
    const table = processTable();
    const at = table.at;
    const runs = readRunFiles();
    const debugs = await Promise.all(runs.map(({ run }) => fetchDebug(run)));

    // cpu rates, as in ProcSampler: cpu-ms gained over wall-ms between scans
    const rates = new Map<number, number>();
    const nextCpu = new Map<string, { cpuMs: number; at: number }>();
    for (const p of table.procs.values()) {
      const key = `${p.pid}:${p.startedAt}`;
      const before = this.prevCpu.get(key);
      nextCpu.set(key, { cpuMs: p.cpuMs, at });
      if (before && at > before.at && p.cpuMs >= before.cpuMs) rates.set(p.pid, (p.cpuMs - before.cpuMs) / (at - before.at));
    }
    this.prevCpu = nextCpu;

    const kids = new Map<number, ProcInfo[]>();
    for (const p of table.procs.values()) {
      const list = kids.get(p.ppid);
      if (list) list.push(p);
      else kids.set(p.ppid, [p]);
    }
    const claimed = new Set<number>();
    const treeOf = (root: ProcInfo): TreeProc[] => {
      const out: TreeProc[] = [];
      const walk = (p: ProcInfo, depth: number) => {
        if (claimed.has(p.pid)) return;
        claimed.add(p.pid);
        out.push({ proc: p, kind: chromeKind(p), depth, cpu: rates.get(p.pid) ?? 0 });
        // A child that started before its "parent" is a reused pid, not a child.
        const children = (kids.get(p.pid) ?? []).filter((c) => c.startedAt === 0 || p.startedAt === 0 || c.startedAt >= p.startedAt);
        children.sort((a, b) => kindRank(chromeKind(a)) - kindRank(chromeKind(b)) || b.commit - a.commit);
        for (const c of children) walk(c, depth + 1);
      };
      walk(root, 0);
      return out;
    };

    // 1. daemons with a run file
    const daemons: Daemon[] = [];
    const orphans: Orphan[] = [];
    runs.forEach(({ run, path }, i) => {
      const proc = table.procs.get(run.pid) ?? null;
      const booted = Date.parse(run.startedAt);
      // The run file outlived its daemon if the pid is gone or now belongs to a later process.
      const alive = proc !== null && isNode(proc) && (proc.startedAt === 0 || !Number.isFinite(booted) || proc.startedAt <= booted + 5000);
      if (!alive) {
        orphans.push({ key: `runfile:${run.profile}`, kind: "runfile", profile: run.profile, root: null, tree: [], memory: 0, commit: 0, cpu: 0, runPath: path });
        return;
      }
      const key = `${run.profile}:${run.pid}`;
      const tree = treeOf(proc);
      const fetched = debugs[i] ?? { error: "down" as const };
      const last = this.lastDebug.get(key) ?? { debug: null, at: 0 };
      if ("debug" in fetched) {
        last.debug = fetched.debug;
        last.at = at;
      }
      this.lastDebug.set(key, last);
      const chrome = tree.filter((t) => t.kind !== "node");
      const mem = {
        nodeWs: proc.memory,
        nodeCommit: proc.commit,
        chromeWs: sum(chrome, (t) => t.proc.memory),
        chromeCommit: sum(chrome, (t) => t.proc.commit),
        chromeProcs: chrome.length,
      };
      const hist = this.hist.get(key) ?? newHistory();
      this.hist.set(key, hist);
      hist.commit.push(at, mem.nodeCommit + mem.chromeCommit);
      hist.ws.push(at, mem.nodeWs + mem.chromeWs);
      hist.chromeCommit.push(at, mem.chromeCommit);
      hist.chromeWs.push(at, mem.chromeWs);
      if ("debug" in fetched) {
        hist.nodeRss.push(at, fetched.debug.node.rss);
        hist.nodeHeap.push(at, fetched.debug.node.heapUsed);
        for (const page of fetched.debug.pages) {
          if (!page.metrics) continue;
          const ph = hist.pages.get(page.tab) ?? { heap: new Series(), nodes: new Series(), listeners: new Series() };
          hist.pages.set(page.tab, ph);
          ph.heap.push(at, page.metrics.jsHeapUsed);
          ph.nodes.push(at, page.metrics.nodes);
          ph.listeners.push(at, page.metrics.listeners);
        }
        const open = new Set(fetched.debug.pages.map((p) => p.tab));
        for (const tab of hist.pages.keys()) if (!open.has(tab)) hist.pages.delete(tab);
      }
      daemons.push({
        key,
        profile: run.profile,
        run,
        runPath: path,
        node: proc,
        tree,
        debug: last.debug,
        debugAt: last.at,
        debugError: "error" in fetched ? fetched.error : null,
        cpu: { node: rates.get(proc.pid) ?? 0, chrome: sum(chrome, (t) => t.cpu) },
        mem,
        hist,
      });
    });

    // 2. daemons nobody can find (run file deleted, daemon still up)
    for (const p of table.procs.values()) {
      const profile = daemonProfileOf(p);
      if (profile === null || claimed.has(p.pid)) continue;
      const tree = treeOf(p);
      orphans.push({ key: `daemon:${p.pid}:${p.startedAt}`, kind: "daemon", profile, root: p, tree, ...cost(tree), runPath: null });
    }

    // 3. bx Chromes whose daemon is gone
    for (const p of table.procs.values()) {
      if (claimed.has(p.pid) || !isChrome(p) || chromeKind(p) !== "browser") continue;
      const profile = bxProfileOf(p);
      if (profile === null) continue;
      const tree = treeOf(p);
      orphans.push({ key: `chrome:${p.pid}:${p.startedAt}`, kind: "chrome", profile, root: p, tree, ...cost(tree), runPath: null });
    }

    // Forget daemons that are gone.
    const live = new Set(daemons.map((d) => d.key));
    for (const key of this.hist.keys()) if (!live.has(key)) this.hist.delete(key);
    for (const key of this.lastDebug.keys()) if (!live.has(key)) this.lastDebug.delete(key);

    daemons.sort((a, b) => a.profile.localeCompare(b.profile));
    const allTrees = [...daemons.map((d) => d.tree), ...orphans.map((o) => o.tree)].flat();
    const totals = {
      chromeProcs: allTrees.filter((t) => t.kind !== "node").length,
      ws: sum(allTrees, (t) => t.proc.memory),
      commit: sum(allTrees, (t) => t.proc.commit),
      cpu: sum(allTrees, (t) => t.cpu),
    };
    this.total.push(at, totals.commit);

    const scan: BxScan = { daemons, orphans, at, error: table.error, totals, hist: this.total };
    if (this.memlogPath) this.appendMemlog(scan);
    return scan;
  }

  private appendMemlog(scan: BxScan): void {
    if (!this.memlogPath) return;
    const lines = scan.daemons.map((d) =>
      JSON.stringify({
        t: new Date(scan.at).toISOString(),
        profile: d.profile,
        pid: d.run.pid,
        nodeWs: d.mem.nodeWs,
        nodeCommit: d.mem.nodeCommit,
        nodeRss: d.debug?.node.rss ?? null,
        nodeHeap: d.debug?.node.heapUsed ?? null,
        chromeWs: d.mem.chromeWs,
        chromeCommit: d.mem.chromeCommit,
        chromeProcs: d.mem.chromeProcs,
        cpu: Math.round((d.cpu.node + d.cpu.chrome) * 1000) / 1000,
        actionLog: d.debug?.internals.actionLog ?? null,
        inFlight: d.debug?.inFlight.length ?? null,
        pages: (d.debug?.pages ?? []).map((p) => ({ tab: p.tab, url: p.url, heap: p.metrics?.jsHeapUsed ?? null, nodes: p.metrics?.nodes ?? null, listeners: p.metrics?.listeners ?? null })),
      }),
    );
    if (lines.length === 0) return;
    try {
      appendFileSync(this.memlogPath, `${lines.join("\n")}\n`);
    } catch {
      // a locked or deleted log file shouldn't take the screen down
    }
  }
}

function kindRank(k: ChromeKind): number {
  return ["node", "browser", "gpu", "network", "storage", "audio", "utility", "crashpad", "renderer", "extension", "other"].indexOf(k);
}

function sum<T>(xs: T[], f: (x: T) => number): number {
  let n = 0;
  for (const x of xs) n += f(x);
  return n;
}

function cost(tree: TreeProc[]): { memory: number; commit: number; cpu: number } {
  return { memory: sum(tree, (t) => t.proc.memory), commit: sum(tree, (t) => t.proc.commit), cpu: sum(tree, (t) => t.cpu) };
}

// ─── who's driving ────────────────────────────────────────────────────────────

export interface Driver {
  key: string;
  /** the status-card label, else Claude's tab name, else the folder */
  label: string;
  /** folder · short session id */
  detail: string;
  via: string | null;
  session: string | null;
  lastSeen: number;
  commands: number;
}

/** Everyone who has sent this daemon a command, most recent first. */
export function driversOf(d: Debug | null): Driver[] {
  if (!d) return [];
  return [...d.clients]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((c) => {
      const s = c.session ? sessionById(c.session) : null;
      const folder = c.cwd ? leaf(c.cwd) : "";
      const label = s?.label ?? s?.name ?? (folder || c.key);
      const detail = [folder, c.session ? c.session.slice(0, 8) : "terminal"].filter(Boolean).join(" · ");
      return { key: c.key, label, detail, via: c.via ?? null, session: c.session ?? null, lastSeen: c.lastSeen, commands: c.commands };
    });
}

// ─── actions ──────────────────────────────────────────────────────────────────

/** Tree-kill off the UI thread (one taskkill, like procs' killRoots). */
export async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    return;
  }
  const proc = Bun.spawn(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

/** The daemon's own shutdown (closes Chrome, deletes its run file); tree-kill if it doesn't answer. */
export async function stopDaemon(d: Daemon): Promise<"stopped" | "killed"> {
  try {
    const res = await fetch(`http://127.0.0.1:${d.run.port}/shutdown`, {
      method: "POST",
      headers: { "x-bx-token": d.run.token },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return "stopped";
  } catch {
    // fall through to the kill
  }
  await killTree(d.run.pid);
  rmSync(d.runPath, { force: true });
  return "killed";
}

export async function killOrphan(o: Orphan): Promise<void> {
  if (o.root) await killTree(o.root.pid);
  if (o.runPath) rmSync(o.runPath, { force: true });
}

async function debugPost<T extends z.ZodType>(d: Daemon, route: string, schema: T, timeoutMs: number): Promise<z.infer<T> | string> {
  try {
    const res = await fetch(`http://127.0.0.1:${d.run.port}${route}`, {
      method: "POST",
      headers: { "x-bx-token": d.run.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return "this daemon predates the debug endpoint — stop it and let bx restart it";
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) return `unexpected answer (HTTP ${res.status})`;
    return parsed.data;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function forceGc(d: Daemon): Promise<{ ran: boolean; heapBefore: number; heapAfter: number } | string> {
  const r = await debugPost(d, "/debug/gc", GcEnvelope, 10_000);
  if (typeof r === "string") return r;
  return r.ok ? r.data : `${r.error.code}: ${r.error.message}`;
}

/** Stalls the daemon for a second or more and writes ~50 MB+ to ~/.bx/heaps. */
export async function heapSnapshot(d: Daemon): Promise<{ path: string; bytes: number; ms: number } | string> {
  const r = await debugPost(d, "/debug/heapsnapshot", SnapshotEnvelope, 120_000);
  if (typeof r === "string") return r;
  return r.ok ? r.data : `${r.error.code}: ${r.error.message}`;
}

export function logPath(profile: string): string {
  return join(LOGS_DIR, `${profile}.log`);
}

/** The last lines of ~/.bx/logs/<profile>.log, read from the end. */
export function readLogTail(profile: string, maxLines: number): string[] {
  const path = logPath(profile);
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, 32 * 1024);
    const buf = Buffer.alloc(len);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, size - len);
    // Playwright's error call logs land in here with their terminal colours.
    const lines = stripAnsi(buf.toString("utf8")).split(/\r?\n/).filter((l) => l.trim() !== "");
    if (len < size) lines.shift(); // the first line was cut in half
    return lines.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
