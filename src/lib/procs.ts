// What every Claude Code session has spun up, and what got left behind.
//
// One `processTable()` per scan (bun:ffi, see ports.ts), then:
//   - every CLI `claude.exe` is a session; its metadata comes from
//     ~/.claude/sessions/<pid>.json (name, status) and Sal's status cards in
//     ~/.sal/status/<project>/<session>.json (label, what it's doing)
//   - each direct child of a session (a Bash-tool shell, a background job, an
//     MCP server) is one "unit": the whole subtree, named by its most telling
//     process, with summed CPU and memory
//   - outside any live session, dev-ish processes (node, bun, ffmpeg, headless
//     chrome, tail/grep, postgres…) climb through their wrappers to a unit
//     root; a root whose parent is gone is an orphan. Orphans run from a
//     Claude scratchpad (…\Temp\claude\<proj>\<session-id>\…) are traced back
//     to that session, live or dead
//
// CPU is a rate: CPU-ms gained between two scans over the wall-ms between
// them, in cores (1.0 = one core flat out). "hot" is a smoothed rate, so one
// busy tick doesn't flag a unit.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { processTable, type ProcInfo } from "./ports.ts";
import { projectsRoot } from "./projects.ts";
import { projectOf } from "./proctext.ts";
import { treeKill } from "./run.ts";

export interface SessionMeta {
  sessionId: string | null;
  /** Claude's tab name ("dutch-pokemon-03") */
  name: string;
  cwd: string;
  status: string | null;
  /** from Sal's status card */
  label: string | null;
  now: string | null;
  cardState: string | null;
}

export type UnitFlag = "hot" | "dupe" | "orphan" | "old" | "mcp" | "service" | "detached" | "daemon";

export interface Unit {
  /** pid:startedAt of the root, stable across scans */
  key: string;
  root: ProcInfo;
  /** the process the unit is named after */
  rep: ProcInfo;
  /** root first, then descendants (depth-first) with their depth */
  tree: { proc: ProcInfo; depth: number; cpu: number }[];
  ports: number[];
  cpu: number;
  /** smoothed cpu — what "hot" and sorting use */
  load: number;
  memory: number;
  project: string;
  flags: Set<UnitFlag>;
  /** how many units share this one's command + cwd (1 = unique) */
  copies: number;
}

export type GroupKind = "session" | "orphans" | "outside";

export interface Group {
  key: string;
  kind: GroupKind;
  title: string;
  project: string;
  /** the claude.exe, for sessions */
  claude: ProcInfo | null;
  session: SessionMeta | null;
  units: Unit[];
  cpu: number;
  load: number;
  memory: number;
  /** the claude process's own cpu, kept apart from what it spawned */
  selfCpu: number;
}

export interface ProcScan {
  groups: Group[];
  at: number;
  error: string | null;
  cores: number;
  totalCpu: number;
  totalMemory: number;
  /** processes counted in some unit */
  procCount: number;
  /** CPU of the whole box (every process, not just ours), in cores */
  machineCpu: number;
}

// ─── classification ───────────────────────────────────────────────────────────

/** Processes that only exist to run another one. A unit is never named after these. */
const WRAPPERS = new Set(["bash.exe", "sh.exe", "nohup.exe", "cmd.exe", "conhost.exe", "timeout.exe", "env.exe", "bunx.exe", "npx.exe", "winpty-agent.exe"]);

/** What counts as dev work when nothing Claude-shaped is above it. */
const DEV = new Set([
  "node.exe", "bun.exe", "bunx.exe", "deno.exe", "python.exe", "pythonw.exe", "python3.exe", "uv.exe",
  "ffmpeg.exe", "ffprobe.exe", "chrome-headless-shell.exe", "postgres.exe", "pg_ctl.exe", "esbuild.exe",
  "tail.exe", "grep.exe", "sleep.exe", "java.exe", "magick.exe", "sox.exe", "yt-dlp.exe", "remotion.exe",
  "watchman.exe", "adb.exe", "caddy.exe", "go.exe", "cargo.exe",
]);

const HOT_CORES = 0.5;
const OLD_MS = 24 * 3600_000;

function lower(p: ProcInfo): string {
  return p.exe.toLowerCase();
}

function isCliClaude(p: ProcInfo, sessionPids: Set<number>): boolean {
  if (sessionPids.has(p.pid)) return true;
  if (lower(p) !== "claude.exe") return false;
  // The desktop app (Electron) is claude.exe too — its helpers carry --type=.
  return p.cmdline !== "" && !/WindowsApps|--type=/i.test(p.cmdline);
}

function isDev(p: ProcInfo): boolean {
  const e = lower(p);
  if (DEV.has(e)) return true;
  if ((e === "chrome.exe" || e === "msedge.exe") && /--headless|--remote-debugging-p(ort|ipe)|puppeteer|playwright|\\bx\\/i.test(p.cmdline)) return true;
  return false;
}

/** Something a dev command is launched through — climb past it when finding a unit root. */
function isLaunchWrapper(p: ProcInfo): boolean {
  const e = lower(p);
  if (e === "bash.exe" || e === "sh.exe") return /\s-c\b/.test(p.cmdline) || p.cmdline === "";
  if (e === "cmd.exe") return /\s\/c\b/i.test(p.cmdline);
  if (e === "pwsh.exe" || e === "powershell.exe") return /\s-(Command|c|File|EncodedCommand)\b/i.test(p.cmdline) && !/-NoExit/i.test(p.cmdline);
  return WRAPPERS.has(e) || DEV.has(e);
}

const SCRATCH = /\\Temp\\claude\\([^\\]+)\\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** `G--code-dutch-pokemon` → `dutch-pokemon` */
function projectFromMangled(m: string): string {
  return m.replace(/^[A-Za-z]--code-/, "") || m;
}

const slashes = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();

function inRoot(path: string, root: string): boolean {
  return slashes(path).startsWith(`${slashes(root)}/`);
}

/** `bun G:\code\sal-agent\src\main.tsx daemon` → `sal-agent` */
function projectInCommand(cmdline: string, root: string): string | null {
  const flat = cmdline.replace(/[\\/]+/g, "/");
  const r = slashes(root);
  const at = flat.toLowerCase().indexOf(`${r}/`);
  if (at < 0) return null;
  return /^[^/"\s]+/.exec(flat.slice(at + r.length + 1))?.[0] ?? null;
}

// ─── session metadata ─────────────────────────────────────────────────────────

const SessionFile = z.object({
  pid: z.number(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
});

const CardFile = z.object({
  session: z.string(),
  label: z.string().nullish(),
  now: z.string().nullish(),
  state: z.string().nullish(),
});

interface MetaCache {
  at: number;
  byPid: Map<number, z.infer<typeof SessionFile>>;
  cards: Map<string, z.infer<typeof CardFile>>;
}
let metaCache: MetaCache | null = null;
const META_MS = 5000;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sessionMeta(): MetaCache {
  if (metaCache && Date.now() - metaCache.at < META_MS) return metaCache;
  const byPid = new Map<number, z.infer<typeof SessionFile>>();
  const sdir = join(homedir(), ".claude", "sessions");
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      const parsed = SessionFile.safeParse(readJson(join(sdir, f)));
      if (parsed.success) byPid.set(parsed.data.pid, parsed.data);
    }
  }
  const cards = new Map<string, z.infer<typeof CardFile>>();
  const cdir = join(homedir(), ".sal", "status");
  if (existsSync(cdir)) {
    for (const proj of readdirSync(cdir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const f of readdirSync(join(cdir, proj.name))) {
        if (!f.endsWith(".json")) continue;
        const parsed = CardFile.safeParse(readJson(join(cdir, proj.name, f)));
        if (parsed.success) cards.set(parsed.data.session, parsed.data);
      }
    }
  }
  metaCache = { at: Date.now(), byPid, cards };
  return metaCache;
}

// ─── cpu sampling ─────────────────────────────────────────────────────────────

interface Sample {
  cpuMs: number;
  at: number;
  rate: number;
  smooth: number;
}

/** Keeps the previous scan so each process gets a rate. One per screen. */
export class ProcSampler {
  private prev = new Map<string, Sample>();

  scan(selfPid = process.pid): ProcScan {
    const table = processTable();
    const cores = cpus().length || 1;
    if (table.error) {
      return { groups: [], at: table.at, error: table.error, cores, totalCpu: 0, totalMemory: 0, procCount: 0, machineCpu: 0 };
    }

    const next = new Map<string, Sample>();
    const rate = new Map<number, { cpu: number; smooth: number }>();
    let machineCpu = 0;
    for (const p of table.procs.values()) {
      const key = `${p.pid}:${p.startedAt}`;
      const before = this.prev.get(key);
      let r = 0;
      if (before && table.at > before.at && p.cpuMs >= before.cpuMs) r = (p.cpuMs - before.cpuMs) / (table.at - before.at);
      // First sight of a process: no rate yet. Smooth toward the new rate so a
      // spike needs two scans to look hot, and a spinner stays hot.
      const smooth = before ? before.smooth * 0.4 + r * 0.6 : r;
      next.set(key, { cpuMs: p.cpuMs, at: table.at, rate: r, smooth });
      rate.set(p.pid, { cpu: r, smooth });
      machineCpu += r;
    }
    this.prev = next;

    return classify(table.procs, table.ports, rate, selfPid, cores, machineCpu, table.at);
  }
}

// ─── grouping ─────────────────────────────────────────────────────────────────

function classify(
  procs: Map<number, ProcInfo>,
  ports: Map<number, number[]>,
  rate: Map<number, { cpu: number; smooth: number }>,
  selfPid: number,
  cores: number,
  machineCpu: number,
  at: number,
): ProcScan {
  const meta = sessionMeta();
  const sessionPids = new Set(meta.byPid.keys());
  const root = projectsRoot();

  /** The real parent: alive, and older than the child (pids get recycled). */
  const parentOf = (p: ProcInfo): ProcInfo | null => {
    const parent = procs.get(p.ppid);
    if (!parent || parent.pid === p.pid) return null;
    if (parent.startedAt && p.startedAt && parent.startedAt > p.startedAt) return null;
    return parent;
  };

  const children = new Map<number, ProcInfo[]>();
  for (const p of procs.values()) {
    const parent = parentOf(p);
    if (!parent) continue;
    const list = children.get(parent.pid);
    if (list) list.push(p);
    else children.set(parent.pid, [p]);
  }

  // This tui and everything above it is never listed (it'd offer to kill itself).
  const protectedPids = new Set<number>();
  for (let p = procs.get(selfPid) ?? null; p && !protectedPids.has(p.pid); p = parentOf(p)) protectedPids.add(p.pid);

  const claudes = [...procs.values()].filter((p) => isCliClaude(p, sessionPids));
  const claudePids = new Set(claudes.map((c) => c.pid));
  const sessionIdOf = new Map<string, number>(); // session id → claude pid
  for (const c of claudes) {
    const id = meta.byPid.get(c.pid)?.sessionId;
    if (id) sessionIdOf.set(id, c.pid);
  }

  const taken = new Set<number>(); // pids already inside a unit
  const cpuOf = (p: ProcInfo) => rate.get(p.pid)?.cpu ?? 0;
  const smoothOf = (p: ProcInfo) => rate.get(p.pid)?.smooth ?? 0;

  const buildUnit = (top: ProcInfo, flags: Set<UnitFlag>): Unit => {
    const tree: Unit["tree"] = [];
    const stack: { proc: ProcInfo; depth: number }[] = [{ proc: top, depth: 0 }];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item || seen.has(item.proc.pid)) continue;
      seen.add(item.proc.pid);
      taken.add(item.proc.pid);
      tree.push({ proc: item.proc, depth: item.depth, cpu: cpuOf(item.proc) });
      // A nested claude (claude -p) stays inside the unit that launched it.
      const kids = [...(children.get(item.proc.pid) ?? [])].sort((a, b) => b.startedAt - a.startedAt);
      for (const k of kids) stack.push({ proc: k, depth: item.depth + 1 });
    }
    const unitPorts = [...new Set(tree.flatMap((t) => ports.get(t.proc.pid) ?? []))].sort((a, b) => a - b);
    const cpu = tree.reduce((n, t) => n + t.cpu, 0);
    const load = tree.reduce((n, t) => n + smoothOf(t.proc), 0);
    const memory = tree.reduce((n, t) => n + t.proc.memory, 0);
    const rep = pickRep(tree.map((t) => t.proc), ports, cpuOf);
    const cwd = rep.cwd || top.cwd;
    // cwd under G:\code, else a scratchpad path, else a G:\code path in the command line (a daemon started from system32).
    const scratch = SCRATCH.exec(cwd) ?? SCRATCH.exec(rep.cmdline);
    const project = scratch?.[1]
      ? projectFromMangled(scratch[1])
      : inRoot(cwd, root)
        ? projectOf(cwd, root).name
        : (projectInCommand(rep.cmdline, root) ?? projectInCommand(top.cmdline, root) ?? "");
    if (load >= HOT_CORES) flags.add("hot");
    if (top.startedAt && at - top.startedAt > OLD_MS) flags.add("old");
    if (/\bmcp\b|modelcontextprotocol|mcp-server|[\\/]mcp[\\/]/i.test(top.cmdline) || /\bmcp\b/i.test(rep.cmdline)) flags.add("mcp");
    // Detached on purpose (sal daemon, bx browser daemons, portless proxy): no parent is normal for these.
    if (/\bdaemon\b|\bproxy start\b|--daemon/i.test(rep.cmdline) || /\bdaemon\b/i.test(top.cmdline)) flags.add("daemon");
    return { key: `${top.pid}:${top.startedAt}`, root: top, rep, tree, ports: unitPorts, cpu, load, memory, project, flags, copies: 1 };
  };

  // 1. sessions: every direct child of a claude is a unit.
  const groups: Group[] = [];
  const sessionGroup = new Map<number, Group>();
  for (const c of claudes) {
    if (protectedPids.has(c.pid)) continue;
    const m = meta.byPid.get(c.pid);
    const card = m?.sessionId ? meta.cards.get(m.sessionId) : undefined;
    const cwd = m?.cwd ?? c.cwd;
    const parentClaude = (() => {
      for (let p = parentOf(c); p; p = parentOf(p)) if (claudePids.has(p.pid)) return p;
      return null;
    })();
    // A headless `claude -p` launched by another session's tool call lives in that session's unit.
    if (parentClaude && !m) continue;
    const session: SessionMeta = {
      sessionId: m?.sessionId ?? null,
      name: m?.name ?? (/\s-p\b|--print/.test(c.cmdline) ? "claude -p (headless)" : "claude"),
      cwd,
      status: m?.status ?? null,
      label: card?.label ?? null,
      now: card?.now ?? null,
      cardState: card?.state ?? null,
    };
    const g: Group = {
      key: `s:${c.pid}:${c.startedAt}`,
      kind: "session",
      title: session.name,
      project: projectOf(cwd, root).name,
      claude: c,
      session,
      units: [],
      cpu: 0,
      load: 0,
      memory: 0,
      selfCpu: cpuOf(c),
    };
    taken.add(c.pid);
    groups.push(g);
    sessionGroup.set(c.pid, g);
  }
  for (const g of groups) {
    const c = g.claude;
    if (!c) continue;
    for (const kid of children.get(c.pid) ?? []) {
      if (taken.has(kid.pid) || protectedPids.has(kid.pid)) continue;
      if (claudePids.has(kid.pid) && sessionGroup.has(kid.pid)) continue; // its own session
      g.units.push(buildUnit(kid, new Set()));
    }
  }

  // 2. everything else that's dev work: climb wrappers to a root, then sort out whose it is.
  const orphanGroups = new Map<string, Group>();
  const outside: Unit[] = [];
  const looseRoots = new Set<number>();
  for (const p of procs.values()) {
    if (taken.has(p.pid) || protectedPids.has(p.pid) || claudePids.has(p.pid) || !isDev(p)) continue;
    let top = p;
    for (let parent = parentOf(top); parent && !protectedPids.has(parent.pid) && !claudePids.has(parent.pid) && isLaunchWrapper(parent); parent = parentOf(top)) {
      top = parent;
    }
    looseRoots.add(top.pid);
  }
  for (const pid of looseRoots) {
    const top = procs.get(pid);
    if (!top || taken.has(pid)) continue;
    const parent = parentOf(top);
    const flags = new Set<UnitFlag>();
    const orphan = parent === null;
    if (orphan) flags.add("orphan");
    if (parent && lower(parent) === "services.exe") flags.add("service");
    const unit = buildUnit(top, flags);
    // Started from a Claude scratchpad? Then we know exactly which session it was.
    const scratch = SCRATCH.exec(unit.rep.cwd) ?? SCRATCH.exec(unit.rep.cmdline) ?? SCRATCH.exec(top.cmdline);
    const owner = scratch?.[2] ? sessionIdOf.get(scratch[2]) : undefined;
    const ownerGroup = owner !== undefined ? sessionGroup.get(owner) : undefined;
    if (ownerGroup) {
      unit.flags.add("detached");
      ownerGroup.units.push(unit);
    } else if (orphan) {
      const project = unit.project || "unknown";
      let g = orphanGroups.get(project);
      if (!g) {
        g = { key: `o:${project}`, kind: "orphans", title: "orphans", project, claude: null, session: null, units: [], cpu: 0, load: 0, memory: 0, selfCpu: 0 };
        orphanGroups.set(project, g);
      }
      g.units.push(unit);
    } else {
      outside.push(unit);
    }
  }
  groups.push(...orphanGroups.values());
  if (outside.length > 0) {
    groups.push({ key: "outside", kind: "outside", title: "outside claude", project: "", claude: null, session: null, units: outside, cpu: 0, load: 0, memory: 0, selfCpu: 0 });
  }

  // 3. duplicates: the same command in the same folder, more than once.
  const all = groups.flatMap((g) => g.units);
  const byCmd = new Map<string, Unit[]>();
  for (const u of all) {
    if (u.flags.has("mcp") || !u.rep.cmdline) continue;
    const k = `${u.rep.cwd.toLowerCase()}|${u.rep.cmdline.replace(/\s+/g, " ").toLowerCase()}`;
    const list = byCmd.get(k);
    if (list) list.push(u);
    else byCmd.set(k, [u]);
  }
  for (const list of byCmd.values()) {
    if (list.length < 2) continue;
    for (const u of list) {
      u.copies = list.length;
      u.flags.add("dupe");
    }
  }

  for (const g of groups) {
    g.units.sort(byLoad);
    g.cpu = g.units.reduce((n, u) => n + u.cpu, 0);
    g.load = g.units.reduce((n, u) => n + u.load, 0);
    g.memory = g.units.reduce((n, u) => n + u.memory, 0);
  }
  const rank: Record<GroupKind, number> = { session: 0, orphans: 0, outside: 1 };
  groups.sort((a, b) => rank[a.kind] - rank[b.kind] || byLoad(a, b));

  return {
    groups,
    at,
    error: null,
    cores,
    totalCpu: all.reduce((n, u) => n + u.cpu, 0),
    totalMemory: all.reduce((n, u) => n + u.memory, 0),
    procCount: all.reduce((n, u) => n + u.tree.length, 0),
    machineCpu,
  };
}

/**
 * Busiest first, in steps of a quarter core so rows don't trade places every
 * scan over a few percent; then memory in 256 MB steps, then a fixed key.
 */
export function byLoad(a: { load: number; memory: number; key: string }, b: { load: number; memory: number; key: string }): number {
  const step = (x: number) => Math.floor(x * 4);
  return step(b.load) - step(a.load) || Math.floor(b.memory / 2 ** 28) - Math.floor(a.memory / 2 ** 28) || a.key.localeCompare(b.key);
}

/** The process that says what a unit is: a listener, else the busiest non-wrapper, else the deepest. */
function pickRep(tree: ProcInfo[], ports: Map<number, number[]>, cpuOf: (p: ProcInfo) => number): ProcInfo {
  const real = tree.filter((p) => !WRAPPERS.has(lower(p)));
  const pool = real.length > 0 ? real : tree;
  const listener = pool.find((p) => (ports.get(p.pid)?.length ?? 0) > 0);
  if (listener) return listener;
  const busiest = [...pool].sort((a, b) => cpuOf(b) - cpuOf(a))[0];
  if (busiest && cpuOf(busiest) > 0.02) return busiest;
  // Otherwise the first real thing a shell ran: `bash -c "bun server.ts"` → bun.
  return pool[0] ?? tree[0] ?? { pid: 0, ppid: 0, exe: "?", cmdline: "", cwd: "", startedAt: 0, memory: 0, cpuMs: 0 };
}

// ─── actions ──────────────────────────────────────────────────────────────────

/**
 * Tree-kill every root in one taskkill (it takes repeated /PID), off the UI
 * thread — 90 orphaned greps one spawnSync at a time would freeze the screen.
 */
export async function killRoots(units: Unit[]): Promise<void> {
  if (units.length === 0) return;
  if (process.platform !== "win32") {
    for (const u of units) treeKill(u.root.pid);
    return;
  }
  const args = units.flatMap((u) => ["/PID", String(u.root.pid)]);
  for (let i = 0; i < args.length; i += 200) {
    const proc = Bun.spawn(["taskkill", "/T", "/F", ...args.slice(i, i + 200)], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  }
}

/** What a group's "✕ all" takes: not MCP servers (a live session loses its tools), services or daemons. */
export function killableUnits(g: Group): Unit[] {
  return g.units.filter((u) => !(g.kind === "session" && u.flags.has("mcp")) && !u.flags.has("service") && !u.flags.has("daemon"));
}

/**
 * The bulk "orphan leftovers" kill: orphans that serve nothing and aren't
 * daemons — dead sessions' tail/grep watchers, headless browsers, one-off
 * scripts. A listening orphan may be a server you're using; those go one at a time.
 */
export function leftoverUnits(groups: Group[]): Unit[] {
  return groups.filter((g) => g.kind === "orphans").flatMap((g) => killableUnits(g).filter((u) => u.ports.length === 0));
}
