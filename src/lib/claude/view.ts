/**
 * Turns the transcript cache into the four views of the Claude usage screen
 * (and `destedtui --usage`): projects, sessions, days, and a project × day
 * heatmap. Everything is filtered to a range of local days.
 *
 * Project = the top-level folder under projectsRoot() that the session's cwd
 * sits in (monorepo subfolders and worktrees roll up); a subagent's spend goes
 * to its parent session. Active time = per-minute activity with gaps capped at
 * IDLE_MIN, unioned across sessions so parallel sessions don't double-count.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { projectsRoot } from "../projects.ts";
import { costOf, ratesFor, shortModel, type TokenCounts } from "./pricing.ts";
import { F, STRIDE, type UsageCache } from "./scan.ts";

const IDLE_MIN = 5;

export type RangeDays = 1 | 7 | 30 | 90 | 0;
export const RANGES: RangeDays[] = [1, 7, 30, 90, 0];
export function rangeLabel(r: RangeDays): string {
  return r === 0 ? "all time" : r === 1 ? "today" : `${r}d`;
}

interface Msg {
  ts: number;
  day: string;
  session: string;
  model: string;
  cost: number;
  tokens: TokenCounts;
}

interface SessionMeta {
  id: string;
  project: string;
  cwd: string;
  title: string | null;
  branch: string | null;
  prompts: number;
  /** Subagent transcripts: agent type (or "agent") per file path. */
  subagents: Map<string, string>;
  mins: number[];
}

export interface Dataset {
  msgs: Msg[];
  sessions: Map<string, SessionMeta>;
  scannedAt: number;
  files: number;
  /** Models priced by family or not at all — surfaced so a missing price is never silent. */
  unpriced: string[];
}

const hourDay = new Map<number, string>();

/** Local YYYY-MM-DD. Memoized per hour — load() calls it for every message and activity minute. */
export function dayKey(sec: number): string {
  const hour = Math.floor(sec / 3600);
  const hit = hourDay.get(hour);
  if (hit) return hit;
  const d = new Date(hour * 3600 * 1000);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  hourDay.set(hour, key);
  return key;
}

/** `G:\code\drydock\web` → `drydock`; `C:\Users\dested` → `~`; else the path itself. */
export function projectOf(cwd: string): string {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const c = norm(cwd);
  const lc = c.toLowerCase();
  const rootRaw = projectsRoot();
  const root = norm(rootRaw).toLowerCase();
  if (lc.startsWith(`${root}/`)) return c.slice(root.length + 1).split("/")[0] ?? c;
  if (lc === root) return rootRaw;
  // Claude spawned from inside a session's scratchpad (…/Temp/claude/G--code-sigil/<session>/…)
  // belongs to the project the slug names.
  const slug = c.match(/\/temp\/claude\/([^/]+)\//i)?.[1];
  if (slug) {
    const rootSlug = root.replace(/[:/]/g, "-");
    if (slug.toLowerCase().startsWith(`${rootSlug}-`)) return slugProject(slug.slice(rootSlug.length + 1), rootRaw);
  }
  const home = norm(homedir()).toLowerCase();
  if (lc === home) return "~";
  if (lc.startsWith(`${home}/`)) return `~/${c.slice(home.length + 1)}`;
  return c.split("/").join(sep === "\\" ? "\\" : "/");
}

const slugMemo = new Map<string, string>();

/** `sal-agent-web` → `sal-agent` when that's the folder that exists (a slug flattens `\` and `-` alike). */
function slugProject(rest: string, root: string): string {
  const hit = slugMemo.get(rest);
  if (hit) return hit;
  let name = rest;
  const parts = rest.split("-");
  for (let n = parts.length; n > 0; n--) {
    const candidate = parts.slice(0, n).join("-");
    if (existsSync(join(root, candidate))) {
      name = candidate;
      break;
    }
  }
  slugMemo.set(rest, name);
  return name;
}

export function load(cache: UsageCache): Dataset {
  const sessions = new Map<string, SessionMeta>();
  const msgs: Msg[] = [];
  const seen = new Set<number>();
  const unpriced = new Set<string>();
  // Oldest file first, so a resumed session's copied history is dropped in favour of the original.
  const entries = Object.entries(cache.files).sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);

  // Main transcripts settle a session's project before its subagents are seen.
  for (const [, f] of entries) {
    if (f.sub || !f.cwd) continue;
    const s = sessions.get(f.sessionId);
    if (s) {
      s.title ??= f.title;
      s.prompts += f.prompts;
      s.mins = mergeMins(s.mins, f.mins);
    } else {
      sessions.set(f.sessionId, {
        id: f.sessionId,
        project: projectOf(f.cwd),
        cwd: f.cwd,
        title: f.title,
        branch: f.branch,
        prompts: f.prompts,
        subagents: new Map(),
        mins: f.mins,
      });
    }
  }
  for (const [path, f] of entries) {
    if (f.m.length === 0) continue;
    let s = sessions.get(f.sessionId);
    if (!s) {
      if (!f.cwd) continue;
      s = { id: f.sessionId, project: projectOf(f.cwd), cwd: f.cwd, title: f.title, branch: f.branch, prompts: 0, subagents: new Map(), mins: [] };
      sessions.set(f.sessionId, s);
    }
    if (f.sub) {
      s.subagents.set(path, f.agent ?? "agent");
      s.mins = mergeMins(s.mins, f.mins);
    }
    for (let i = 0; i < f.m.length; i += STRIDE) {
      const hash = f.m[i + F.hash] ?? 0;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const model = cache.models[f.m[i + F.model] ?? 0] ?? "unknown";
      const tokens: TokenCounts = {
        input: f.m[i + F.input] ?? 0,
        output: f.m[i + F.output] ?? 0,
        cacheRead: f.m[i + F.cacheRead] ?? 0,
        cacheWrite5m: f.m[i + F.cw5] ?? 0,
        cacheWrite1h: f.m[i + F.cw1] ?? 0,
      };
      if (ratesFor(model).estimated) unpriced.add(model);
      const ts = f.m[i + F.ts] ?? 0;
      msgs.push({ ts, day: dayKey(ts), session: s.id, model, cost: costOf(model, tokens, f.m[i + F.fast] === 1), tokens });
    }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  return { msgs, sessions, scannedAt: cache.scannedAt, files: Object.keys(cache.files).length, unpriced: [...unpriced] };
}

function mergeMins(a: number[], b: number[]): number[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/** Minutes of activity: each event minute counts until the next, capped at IDLE_MIN. */
export function activeMinutes(sortedMins: number[]): number {
  let total = 0;
  for (let i = 0; i < sortedMins.length; i++) {
    const cur = sortedMins[i] ?? 0;
    const next = sortedMins[i + 1];
    total += next === undefined ? 1 : Math.max(1, Math.min(next - cur, IDLE_MIN));
  }
  return total;
}

function addTokens(into: TokenCounts, t: TokenCounts): void {
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheWrite5m += t.cacheWrite5m;
  into.cacheWrite1h += t.cacheWrite1h;
}

const zeroTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

export interface ProjectRow {
  name: string;
  cost: number;
  tokens: TokenCounts;
  sessions: number;
  activeDays: number;
  activeMin: number;
  lastTs: number;
  /** Daily cost, oldest → newest, one value per day of the range (capped at 30). */
  series: number[];
  /** "opus 5.5 71% · fable 5.1 22%" */
  models: string;
}

export interface SessionRow {
  id: string;
  project: string;
  cwd: string;
  title: string;
  branch: string | null;
  start: number;
  end: number;
  activeMin: number;
  cost: number;
  tokens: TokenCounts;
  prompts: number;
  subagents: number;
  agents: string;
  models: string;
}

export interface DayRow {
  day: string;
  cost: number;
  tokens: TokenCounts;
  activeMin: number;
  sessions: number;
  projects: { name: string; cost: number; activeMin: number }[];
}

export interface HeatCell {
  cost: number;
  activeMin: number;
  sessions: number;
}

export interface Summary {
  range: RangeDays;
  /** Local day keys covered, oldest → newest (only days with activity when range is all-time). */
  days: string[];
  total: { cost: number; tokens: TokenCounts; activeMin: number; sessions: number; projects: number };
  projects: ProjectRow[];
  sessions: SessionRow[];
  dayRows: DayRow[];
  /** project → day → cell */
  heat: Map<string, Map<string, HeatCell>>;
  models: string;
}

function modelMix(costByModel: Map<string, number>, max = 2): string {
  const total = [...costByModel.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return [...costByModel.keys()].slice(0, max).map(shortModel).join(" · ");
  const merged = new Map<string, number>();
  for (const [m, c] of costByModel) merged.set(shortModel(m), (merged.get(shortModel(m)) ?? 0) + c);
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([m, c]) => `${m} ${Math.round((c / total) * 100)}%`)
    .join(" · ");
}

function rangeDays(range: number, now: number): string[] {
  if (range === 0) return [];
  const out: string[] = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  for (let i = range - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(dayKey(Math.floor(x.getTime() / 1000)));
  }
  return out;
}

export function summarize(ds: Dataset, range: RangeDays, now = Date.now()): Summary {
  const fixedDays = rangeDays(range, now);
  const firstDay = fixedDays[0] ?? "";
  const inRange = (day: string) => range === 0 || day >= firstDay;

  interface PAcc {
    cost: number;
    tokens: TokenCounts;
    sessions: Set<string>;
    days: Map<string, number>;
    lastTs: number;
    models: Map<string, number>;
  }
  interface SAcc {
    cost: number;
    tokens: TokenCounts;
    start: number;
    end: number;
    models: Map<string, number>;
  }
  interface DAcc {
    cost: number;
    tokens: TokenCounts;
    sessions: Set<string>;
    projects: Map<string, number>;
  }
  const pAcc = new Map<string, PAcc>();
  const sAcc = new Map<string, SAcc>();
  const dAcc = new Map<string, DAcc>();
  const heat = new Map<string, Map<string, HeatCell>>();
  const allModels = new Map<string, number>();
  const total = { cost: 0, tokens: zeroTokens(), activeMin: 0, sessions: 0, projects: 0 };

  for (const m of ds.msgs) {
    if (!inRange(m.day)) continue;
    const meta = ds.sessions.get(m.session);
    if (!meta) continue;
    const proj = meta.project;

    let p = pAcc.get(proj);
    if (!p) pAcc.set(proj, (p = { cost: 0, tokens: zeroTokens(), sessions: new Set(), days: new Map(), lastTs: 0, models: new Map() }));
    p.cost += m.cost;
    addTokens(p.tokens, m.tokens);
    p.sessions.add(m.session);
    p.days.set(m.day, (p.days.get(m.day) ?? 0) + m.cost);
    p.lastTs = Math.max(p.lastTs, m.ts);
    p.models.set(m.model, (p.models.get(m.model) ?? 0) + m.cost);

    let s = sAcc.get(m.session);
    if (!s) sAcc.set(m.session, (s = { cost: 0, tokens: zeroTokens(), start: m.ts, end: m.ts, models: new Map() }));
    s.cost += m.cost;
    addTokens(s.tokens, m.tokens);
    s.start = Math.min(s.start, m.ts);
    s.end = Math.max(s.end, m.ts);
    s.models.set(m.model, (s.models.get(m.model) ?? 0) + m.cost);

    let d = dAcc.get(m.day);
    if (!d) dAcc.set(m.day, (d = { cost: 0, tokens: zeroTokens(), sessions: new Set(), projects: new Map() }));
    d.cost += m.cost;
    addTokens(d.tokens, m.tokens);
    d.sessions.add(m.session);
    d.projects.set(proj, (d.projects.get(proj) ?? 0) + m.cost);

    let row = heat.get(proj);
    if (!row) heat.set(proj, (row = new Map()));
    const cell = row.get(m.day) ?? { cost: 0, activeMin: 0, sessions: 0 };
    cell.cost += m.cost;
    row.set(m.day, cell);

    allModels.set(m.model, (allModels.get(m.model) ?? 0) + m.cost);
    total.cost += m.cost;
    addTokens(total.tokens, m.tokens);
  }

  // Activity minutes, bucketed by local day, per session — then unioned per project/day.
  const firstMin = range === 0 ? -Infinity : Math.floor(new Date(`${firstDay}T00:00:00`).getTime() / 60_000);
  const minsBySession = new Map<string, number[]>();
  const projDayMins = new Map<string, Map<string, Set<number>>>();
  const dayMins = new Map<string, Set<number>>();
  const projMins = new Map<string, Set<number>>();
  const allMins = new Set<number>();
  for (const id of sAcc.keys()) {
    const meta = ds.sessions.get(id);
    if (!meta) continue;
    const mins = meta.mins.filter((x) => x >= firstMin);
    minsBySession.set(id, mins);
    let pd = projDayMins.get(meta.project);
    if (!pd) projDayMins.set(meta.project, (pd = new Map()));
    let pm = projMins.get(meta.project);
    if (!pm) projMins.set(meta.project, (pm = new Set()));
    const sessionDays = new Set<string>();
    for (const x of mins) {
      const day = dayKey(x * 60);
      sessionDays.add(day);
      let set = pd.get(day);
      if (!set) pd.set(day, (set = new Set()));
      set.add(x);
      let ds2 = dayMins.get(day);
      if (!ds2) dayMins.set(day, (ds2 = new Set()));
      ds2.add(x);
      pm.add(x);
      allMins.add(x);
    }
    const row = heat.get(meta.project);
    for (const day of sessionDays) {
      const cell = row?.get(day);
      if (cell) cell.sessions++;
    }
  }
  const sortedActive = (s: Set<number> | undefined) => (s ? activeMinutes([...s].sort((a, b) => a - b)) : 0);
  for (const [proj, byDay] of projDayMins) {
    const row = heat.get(proj);
    if (!row) continue;
    for (const [day, set] of byDay) {
      const cell = row.get(day);
      if (cell) cell.activeMin = sortedActive(set);
    }
  }

  // All-time is continuous from the first day with usage — a timeline with the idle days cut out would lie.
  const firstTs = range === 0 ? ds.msgs.find((m) => m.ts > 0)?.ts : undefined;
  const days = firstTs === undefined ? fixedDays : rangeDays(Math.max(1, Math.ceil((now / 1000 - firstTs) / 86_400) + 1), now);
  const sparkDays = days.slice(-30);

  const projects: ProjectRow[] = [...pAcc.entries()].map(([name, p]) => ({
    name,
    cost: p.cost,
    tokens: p.tokens,
    sessions: p.sessions.size,
    activeDays: p.days.size,
    activeMin: sortedActive(projMins.get(name)),
    lastTs: p.lastTs,
    series: sparkDays.map((d) => p.days.get(d) ?? 0),
    models: modelMix(p.models),
  }));
  projects.sort((a, b) => b.cost - a.cost);

  const sessions: SessionRow[] = [...sAcc.entries()].map(([id, s]) => {
    const meta = ds.sessions.get(id);
    const agents = new Map<string, number>();
    for (const a of meta?.subagents.values() ?? []) agents.set(a, (agents.get(a) ?? 0) + 1);
    return {
      id,
      project: meta?.project ?? "?",
      cwd: meta?.cwd ?? "",
      title: meta?.title ?? "",
      branch: meta?.branch ?? null,
      start: s.start,
      end: s.end,
      activeMin: activeMinutes(minsBySession.get(id) ?? []),
      cost: s.cost,
      tokens: s.tokens,
      prompts: meta?.prompts ?? 0,
      subagents: meta?.subagents.size ?? 0,
      agents: [...agents.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([a, n]) => (n > 1 ? `${a}×${n}` : a))
        .join(" "),
      models: modelMix(s.models),
    };
  });
  sessions.sort((a, b) => b.end - a.end);

  const dayRows: DayRow[] = [...dAcc.entries()]
    .map(([day, d]) => ({
      day,
      cost: d.cost,
      tokens: d.tokens,
      activeMin: sortedActive(dayMins.get(day)),
      sessions: d.sessions.size,
      projects: [...d.projects.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, cost]) => ({ name, cost, activeMin: heat.get(name)?.get(day)?.activeMin ?? 0 })),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));

  total.activeMin = sortedActive(allMins);
  total.sessions = sAcc.size;
  total.projects = pAcc.size;
  return { range, days, total, projects, sessions, dayRows, heat, models: modelMix(allModels, 3) };
}

// --- formatting ---------------------------------------------------------------

export function usd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

export function tok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

export function hm(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export function when(sec: number, now = Date.now()): string {
  const d = new Date(sec * 1000);
  const today = dayKey(Math.floor(now / 1000));
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (dayKey(sec) === today) return `today ${time}`;
  const diff = (now - d.getTime()) / 86_400_000;
  if (diff < 6) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

export function tokenBreakdown(t: TokenCounts): string {
  return `in ${tok(t.input)} · out ${tok(t.output)} · cache read ${tok(t.cacheRead)} · write ${tok(t.cacheWrite5m + t.cacheWrite1h)}`;
}
