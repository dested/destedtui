import { existsSync } from "node:fs";
import { join } from "node:path";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { Footer, type Hint } from "../components/Footer.tsx";
import { ActionBar, btn, seg, type BarItem } from "../components/ActionBar.tsx";
import { fit, pad } from "../lib/text.ts";
import { projectsRoot } from "../lib/projects.ts";
import { sparkline } from "../lib/keys/usage/view.ts";
import { readCache, workerMsgSchema, type ScanProgress } from "../lib/claude/scan.ts";
import {
  dayKey,
  hm,
  load,
  rangeLabel,
  RANGES,
  summarize,
  tok,
  tokenBreakdown,
  totalTokens,
  usd,
  when,
  type Dataset,
  type DayRow,
  type ProjectRow,
  type RangeDays,
  type SessionRow,
  type Summary,
} from "../lib/claude/view.ts";

const ACCENT = T.purple;
const VIEWS = ["projects", "timeline", "sessions", "days"] as const;
type View = (typeof VIEWS)[number];
const SORTS = ["cost", "recent", "active"] as const;
type Sort = (typeof SORTS)[number];

const DETAIL_ROWS = 3;
const RESCAN_MS = 2 * 60_000;
const HEAT = ["░", "▒", "▓", "█"];

interface Props {
  back: () => void;
  /** cd the shell into a folder (and optionally run a command there), ending the tui. */
  choose: (dir: string, command?: string) => void;
}

type ScanState = { kind: "idle"; read: number } | { kind: "scanning"; p: ScanProgress | null } | { kind: "error"; message: string };

interface SessionFilter {
  project?: string;
  /** Inclusive local-day range — one day from the day log, a week from the weekly timeline. */
  from?: string;
  to?: string;
}

/** A timeline column: one day, or a Monday-start week (clipped to the range). */
interface Bucket {
  days: string[];
  label: string;
}

function buckets(days: string[], weekly: boolean): Bucket[] {
  if (!weekly) return days.map((d) => ({ days: [d], label: d.slice(5) }));
  const out: Bucket[] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && new Date(`${d}T12:00:00`).getDay() !== 1) last.days.push(d);
    else out.push({ days: [d], label: d.slice(5) });
  }
  return out;
}

function spanLabel(from: string, to: string): string {
  if (from === to) return weekdayDate(from);
  const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${short(from)} – ${short(to)}`;
}

/** Keep `sel` inside a window of `vis` rows that moves only when it has to. */
function windowTop(prev: number, sel: number, count: number, vis: number): number {
  let t = Math.min(prev, Math.max(0, count - vis));
  if (sel < t) t = sel;
  if (sel >= t + vis) t = sel - vis + 1;
  return Math.max(0, t);
}

function weekdayDate(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Sessions with any activity in [from, to] — approximated by their first..last message span. */
function sessionTouches(s: SessionRow, from: string, to: string): boolean {
  return dayKey(s.start) <= to && from <= dayKey(s.end);
}

/**
 * Claude Code usage from the transcripts in ~/.claude/projects: what each
 * project cost (API-equivalent list prices), when you worked on it, and every
 * session — projects table, a project × day heatmap, sessions, and a day log.
 */
export function ClaudeUsage({ back, choose }: Props) {
  const { width, height } = useTerminalDimensions();
  const [ds, setDs] = useState<Dataset | null>(null);
  const [scanState, setScanState] = useState<ScanState>({ kind: "scanning", p: null });
  const [view, setView] = useState<View>("projects");
  const [range, setRange] = useState<RangeDays>(30);
  const [sort, setSort] = useState<Sort>("cost");
  const [sel, setSel] = useState<Record<View, number>>({ projects: 0, timeline: 0, sessions: 0, days: 0 });
  const [dayCursor, setDayCursor] = useState<number | null>(null);
  const [weekly, setWeekly] = useState(false);
  const [filter, setFilter] = useState<SessionFilter>({});
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const [flash, setFlash] = useState<{ text: string; color: string } | null>(null);
  const [frame, setFrame] = useState(0);
  const tops = useRef<Record<View, number>>({ projects: 0, timeline: 0, sessions: 0, days: 0 });
  const worker = useRef<Worker | null>(null);
  const dayStart = useRef<number | null>(null);

  const reload = () => {
    const cache = readCache();
    if (cache) setDs(load(cache));
  };

  const rescan = () => {
    if (worker.current) return;
    const w = new Worker(new URL("../lib/claude/scanWorker.ts", import.meta.url).href);
    worker.current = w;
    setScanState({ kind: "scanning", p: null });
    const finish = () => {
      w.terminate();
      worker.current = null;
    };
    w.onmessage = (e: MessageEvent<unknown>) => {
      const msg = workerMsgSchema.safeParse(e.data);
      if (!msg.success) return;
      const m = msg.data;
      if (m.type === "progress") setScanState({ kind: "scanning", p: { done: m.done, total: m.total, read: m.read, bytes: m.bytes } });
      else if (m.type === "done") {
        finish();
        if (m.read > 0) reload();
        setScanState({ kind: "idle", read: m.read });
      } else {
        finish();
        setScanState({ kind: "error", message: m.message });
      }
    };
    w.onerror = (e) => {
      finish();
      setScanState({ kind: "error", message: e.message });
    };
    w.postMessage("scan");
  };

  useEffect(() => {
    // Paint first, then load the cache (~300ms) and bring it up to date in the worker.
    const boot = setTimeout(() => {
      reload();
      rescan();
    }, 0);
    const again = setInterval(rescan, RESCAN_MS);
    const spin = setInterval(() => setFrame((f) => f + 1), 120);
    return () => {
      clearTimeout(boot);
      clearInterval(again);
      clearInterval(spin);
      worker.current?.terminate();
      worker.current = null;
    };
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const summary = useMemo(() => (ds ? summarize(ds, range) : null), [ds, range]);

  const projects = useMemo(() => {
    const rows = [...(summary?.projects ?? [])];
    if (sort === "recent") rows.sort((a, b) => b.lastTs - a.lastTs);
    else if (sort === "active") rows.sort((a, b) => b.activeMin - a.activeMin);
    return rows;
  }, [summary, sort]);

  const sessions = useMemo(() => {
    const q = text.toLowerCase();
    return (summary?.sessions ?? []).filter(
      (s) =>
        (!filter.project || s.project === filter.project) &&
        (!filter.from || !filter.to || sessionTouches(s, filter.from, filter.to)) &&
        (!q || s.title.toLowerCase().includes(q) || s.project.toLowerCase().includes(q) || s.id.startsWith(q)),
    );
  }, [summary, filter, text]);

  const heatRows = summary?.projects ?? [];
  const dayRows = summary?.dayRows ?? [];
  const days = summary?.days ?? [];
  const cols = useMemo(() => buckets(summary?.days ?? [], weekly), [summary, weekly]);

  // --- geometry ---------------------------------------------------------------
  const inner = Math.max(70, width - 6);
  // header 3 + border 2 + tabs + summary + column header + detail + action bar + status + footer/margins 2
  const visRows = Math.max(3, height - 12 - DETAIL_ROWS);
  const counts: Record<View, number> = { projects: projects.length, timeline: heatRows.length, sessions: sessions.length, days: dayRows.length };
  const count = counts[view];
  const cur = Math.min(sel[view], Math.max(0, count - 1));
  const top = windowTop(tops.current[view], cur, count, visRows);
  tops.current[view] = top;
  const cursorCol = Math.min(dayCursor ?? cols.length - 1, cols.length - 1);
  const filtered = Boolean(filter.project || filter.from || text);

  const changeRange = (r: RangeDays) => {
    setDayCursor(null);
    dayStart.current = null;
    setRange(r);
  };
  const setGrain = (w: boolean) => {
    setDayCursor(null);
    dayStart.current = null;
    setWeekly(w);
  };
  const moveCol = (by: number) => setDayCursor(Math.max(0, Math.min(cols.length - 1, cursorCol + by)));
  const clearFilter = () => {
    setFilter({});
    setText("");
    setTyping(false);
  };

  const select = (i: number) => setSel((s) => ({ ...s, [view]: Math.max(0, Math.min(count - 1, i)) }));
  const switchView = (v: View) => {
    setView(v);
    setTyping(false);
  };

  const projectDir = (name: string): string | null => {
    const root = join(projectsRoot(), name);
    if (existsSync(root)) return root;
    const latest = summary?.sessions.find((s) => s.project === name);
    return latest && existsSync(latest.cwd) ? latest.cwd : null;
  };
  const cdProject = (name: string | undefined) => {
    if (!name) return;
    const dir = projectDir(name);
    if (dir) choose(dir);
    else setFlash({ text: `✗ no folder for ${name} on disk`, color: T.red });
  };
  const resume = (s: SessionRow | undefined) => {
    if (!s) return;
    if (!existsSync(s.cwd)) return setFlash({ text: `✗ ${s.cwd} no longer exists`, color: T.red });
    choose(s.cwd, `claude --resume ${s.id}`);
  };
  const showSessions = (f: SessionFilter) => {
    setFilter(f);
    setText("");
    setSel((s) => ({ ...s, sessions: 0 }));
    setView("sessions");
  };
  const enter = () => {
    if (view === "projects") {
      const p = projects[cur];
      if (p) showSessions({ project: p.name });
    } else if (view === "timeline") {
      const p = heatRows[cur];
      const col = cols[cursorCol];
      if (p && col) showSessions({ project: p.name, from: col.days[0], to: col.days[col.days.length - 1] });
    } else if (view === "days") {
      const d = dayRows[cur];
      if (d) showSessions({ from: d.day, to: d.day });
    } else resume(sessions[cur]);
  };

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (typing) {
      if (key.name === "escape") {
        setText("");
        setTyping(false);
      } else if (key.name === "return") setTyping(false);
      else if (key.name === "backspace") setText((t) => t.slice(0, -1));
      else if (key.name === "up") select(cur - 1);
      else if (key.name === "down") select(cur + 1);
      else if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
        const ch = key.sequence;
        setText((t) => t + ch);
      }
      return;
    }
    if (key.name === "escape" || key.sequence === "q") {
      if (view === "sessions" && filtered) return clearFilter();
      return back();
    }
    if (key.name === "tab") {
      const i = VIEWS.indexOf(view) + (key.shift ? VIEWS.length - 1 : 1);
      return switchView(VIEWS[i % VIEWS.length] ?? "projects");
    }
    if (key.name === "up") return select(cur - 1);
    if (key.name === "down") return select(cur + 1);
    if (key.name === "pageup") return select(cur - visRows);
    if (key.name === "pagedown") return select(cur + visRows);
    if (key.name === "home") return select(0);
    if (key.name === "end") return select(count - 1);
    if (key.name === "return") return enter();
    if (view === "timeline" && (key.name === "left" || key.name === "right")) {
      const step = key.shift ? (weekly ? 4 : 7) : 1;
      return moveCol(key.name === "left" ? -step : step);
    }
    switch (key.sequence) {
      case "1":
      case "2":
      case "3":
      case "4":
        return switchView(VIEWS[Number(key.sequence) - 1] ?? "projects");
      case "d":
        return changeRange(RANGES[(RANGES.indexOf(range) + 1) % RANGES.length] ?? 30);
      case "D":
        return changeRange(RANGES[(RANGES.indexOf(range) + RANGES.length - 1) % RANGES.length] ?? 30);
      case "w":
        if (view === "timeline") setGrain(!weekly);
        return;
      case "s":
        if (view === "projects") setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length] ?? "cost");
        return;
      case "r":
        return rescan();
      case "/":
        if (view === "sessions") setTyping(true);
        return;
      case "g":
        if (view === "projects") return cdProject(projects[cur]?.name);
        if (view === "timeline") return cdProject(heatRows[cur]?.name);
        if (view === "sessions") return cdProject(sessions[cur]?.project);
        return;
    }
  });

  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
  const hints: Hint[] = [
    ["click", "anything"],
    ["↑↓", "select"],
    ...(view === "timeline" ? ([["←→", weekly ? "week" : "day"]] satisfies Hint[]) : []),
    ["enter", view === "sessions" ? "resume" : "sessions"],
    ["esc", view === "sessions" && filtered ? "clear filter" : "back"],
  ];

  // The action bar holds screen-level controls only. Row actions live on the row: hover selects,
  // so a mouse travelling down to a bar button would cross (and retarget) other rows.
  const actions: BarItem[] = [];
  if (summary) {
    if (view === "projects") actions.push(seg("sort", SORTS, sort, setSort));
    else if (view === "timeline") {
      actions.push(seg("show", ["days", "weeks"], weekly ? "weeks" : "days", (v) => setGrain(v === "weeks")));
      actions.push(btn(weekly ? "« 4w" : "« 7d", T.dim, () => moveCol(weekly ? -4 : -7)));
      actions.push(btn("◀", T.fg, () => moveCol(-1)));
      actions.push(btn("▶", T.fg, () => moveCol(1)));
      actions.push(btn(weekly ? "4w »" : "7d »", T.dim, () => moveCol(weekly ? 4 : 7)));
    } else if (view === "sessions") {
      actions.push(btn(typing ? "⌕ typing…" : "⌕ filter", T.yellow, () => setTyping(true)));
      if (filtered) actions.push(btn("✕ clear filter", T.red, clearFilter));
    }
  }
  const trailing: BarItem[] = [
    { kind: "btn", label: scanState.kind === "scanning" ? `${spin} scanning` : "↻ rescan", color: T.cyan, onPress: rescan },
    { kind: "btn", label: "← back", color: T.dim, onPress: back },
  ];

  let body: ReactNode;
  let columns = "";
  let detail: { text: string; color: string }[] = [];
  if (!summary) {
    body = (
      <text fg={T.dim}>
        {pad(scanState.kind === "error" ? `✗ ${scanState.message}` : `${spin} reading ~/.claude/projects — the first scan reads every transcript and takes about a minute`, inner)}
      </text>
    );
  } else if (view === "projects") {
    const g = projectGeometry(inner);
    columns = `  ${pad("project", g.nameW)}${"cost".padStart(10)}${"tokens".padStart(8)}${"sess".padStart(6)}${"days".padStart(6)}${"active".padStart(8)}  ${pad(`last ${Math.min(g.sparkW, days.length)}d`, g.sparkW + 1)}${pad("last", 13)}${pad("models", g.modelsW)}`;
    body = projects.slice(top, top + visRows).map((p, i) => (
      <ProjectLine key={p.name} p={p} g={g} width={inner} selected={top + i === cur} onHover={() => select(top + i)} onPress={() => showSessions({ project: p.name })} onOpenFolder={() => cdProject(p.name)} />
    ));
    const p = projects[cur];
    if (p) {
      const dir = projectDir(p.name);
      const perHour = p.activeMin > 0 ? ` · ${usd(p.cost / (p.activeMin / 60))}/active hour` : "";
      detail = [
        { text: `${p.name}${dir ? ` · ${dir}` : ""} · ${p.sessions} session${p.sessions === 1 ? "" : "s"} over ${p.activeDays} day${p.activeDays === 1 ? "" : "s"} · ${hm(p.activeMin)} active${perHour}`, color: T.fg },
        { text: tokenBreakdown(p.tokens), color: T.dim },
        { text: `${(summary.total.cost > 0 ? (p.cost / summary.total.cost) * 100 : 0).toFixed(1)}% of ${rangeLabel(range)} spend · models ${p.models}`, color: T.dim },
      ];
    }
  } else if (view === "timeline") {
    const g = timelineGeometry(inner, cols.length, cursorCol, dayStart.current ?? Math.max(0, cols.length - 1), weekly);
    dayStart.current = g.start;
    columns = timelineHeader(cols, g, inner, weekly);
    let max = 0;
    for (const p of heatRows) for (const b of cols.slice(g.start, g.start + g.cols)) max = Math.max(max, bucketCell(summary, p.name, b).cost);
    body = heatRows.slice(top, top + visRows).map((p, i) => (
      <HeatLine
        key={p.name}
        p={p}
        summary={summary}
        cols={cols}
        g={g}
        max={max}
        cursor={cursorCol}
        width={inner}
        selected={top + i === cur}
        onHover={() => select(top + i)}
        onPick={(col) => {
          const b = cols[col];
          // A second click on the cursor cell drills in, so the mouse never travels to a bar button.
          if (top + i === cur && col === cursorCol && b) return showSessions({ project: p.name, from: b.days[0], to: b.days[b.days.length - 1] });
          select(top + i);
          setDayCursor(col);
        }}
      />
    ));
    const p = heatRows[cur];
    const col = cols[cursorCol];
    const from = col?.days[0];
    const to = col?.days[col.days.length - 1];
    if (p && col && from && to) {
      const cell = bucketCell(summary, p.name, col);
      const touched = summary.sessions.filter((s) => s.project === p.name && sessionTouches(s, from, to));
      const titles = touched.map((s) => s.title || s.id.slice(0, 8));
      const inCol = dayRows.filter((d) => d.day >= from && d.day <= to);
      const colCost = inCol.reduce((n, d) => n + d.cost, 0);
      const colActive = inCol.reduce((n, d) => n + d.activeMin, 0);
      const colProjects = new Set(inCol.flatMap((d) => d.projects.map((x) => x.name))).size;
      detail = [
        {
          text: `${p.name} · ${spanLabel(from, to)} · ${cell.cost > 0 ? `${usd(cell.cost)} · ${hm(cell.activeMin)} active · ${touched.length} session${touched.length === 1 ? "" : "s"}` : "nothing"}`,
          color: cell.cost > 0 ? T.fg : T.dim,
        },
        { text: titles.length ? titles.join(" · ") : "", color: T.dim },
        {
          text: inCol.length ? `whole ${weekly ? "week" : "day"}: ${usd(colCost)} · ${hm(colActive)} active across ${colProjects} project${colProjects === 1 ? "" : "s"}` : "",
          color: T.dim,
        },
      ];
    }
  } else if (view === "sessions") {
    const g = sessionGeometry(inner);
    columns = `  ${pad("last active", 13)}${"active".padStart(7)}  ${pad("project", g.projW)}${pad("title", g.titleW)}${"cost".padStart(10)}${"tokens".padStart(8)}${"sub".padStart(5)}${" ".repeat(BTN_W)}`;
    body =
      sessions.length === 0 ? (
        <text fg={T.dim}>{pad(text ? `no session matches "${text}"` : "no sessions in this range", inner)}</text>
      ) : (
        sessions.slice(top, top + visRows).map((s, i) => (
          <SessionLine key={s.id} s={s} g={g} width={inner} selected={top + i === cur} onHover={() => select(top + i)} onResume={() => resume(s)} />
        ))
      );
    const s = sessions[cur];
    if (s) {
      const subs = s.subagents ? ` · ${s.subagents} subagent${s.subagents === 1 ? "" : "s"}: ${s.agents}` : "";
      detail = [
        { text: `${s.title || "(untitled)"} · ${s.id}`, color: T.fg },
        { text: `${s.cwd}${s.branch ? ` ⎇ ${s.branch}` : ""} · ${when(s.start)} → ${when(s.end)} · ${s.prompts} prompt${s.prompts === 1 ? "" : "s"}${subs}`, color: T.dim },
        { text: `${s.models} · ${tokenBreakdown(s.tokens)}`, color: T.dim },
      ];
    }
  } else {
    const g = dayGeometry(inner);
    columns = `  ${pad("day", 12)}${"cost".padStart(10)}${"active".padStart(8)}${"sess".padStart(6)}${"tokens".padStart(8)}  ${pad("projects", g.projW)}`;
    body = dayRows.slice(top, top + visRows).map((d, i) => (
      <DayLine key={d.day} d={d} g={g} width={inner} selected={top + i === cur} onHover={() => select(top + i)} onPress={() => showSessions({ from: d.day, to: d.day })} />
    ));
    const d = dayRows[cur];
    if (d) {
      const all = d.projects.map((p) => `${p.name} ${usd(p.cost)} ${hm(p.activeMin)}`).join(" · ");
      detail = [
        { text: `${weekdayDate(d.day)} · ${usd(d.cost)} · ${hm(d.activeMin)} active · ${d.sessions} sessions · ${tokenBreakdown(d.tokens)}`, color: T.fg },
        { text: fit(all, inner), color: T.dim },
        { text: all.length > inner ? fit(all.slice(inner - 1), inner) : "", color: T.dim },
      ];
    }
  }
  while (detail.length < DETAIL_ROWS) detail.push({ text: "", color: T.dim });

  const status =
    flash ??
    (scanState.kind === "scanning"
      ? {
          text: scanState.p && scanState.p.read > 0
            ? `${spin} scanning transcripts ${scanState.p.done}/${scanState.p.total} · ${(scanState.p.bytes / 1e9).toFixed(1)} GB read`
            : `${spin} checking for new transcripts…`,
          color: T.yellow,
        }
      : scanState.kind === "error"
        ? { text: `✗ scan failed: ${scanState.message}`, color: T.red }
        : {
            text: `${ds ? `${ds.files} transcripts` : ""} · API-equivalent list prices (a Max plan isn't billed per token) · background haiku calls aren't in transcripts${ds && ds.unpriced.length ? ` · ⚠ priced by family: ${ds.unpriced.join(", ")}` : ""}`,
            color: ds && ds.unpriced.length ? T.yellow : T.dim,
          });

  const scope = [filter.project, filter.from && filter.to ? spanLabel(filter.from, filter.to) : ""].filter(Boolean).join(" · ");
  const filterText =
    view !== "sessions" ? "" : typing ? `  /${text}▏` : scope || text ? `  ▸ ${[scope, text ? `"${text}"` : ""].filter(Boolean).join(" · ")}` : "";

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" claude usage "
        style={{
          flexGrow: 1,
          flexDirection: "column",
          border: true,
          borderStyle: "rounded",
          borderColor: scanState.kind === "error" ? T.red : T.border,
          titleColor: ACCENT,
          margin: 1,
          marginTop: 0,
          padding: 1,
          paddingTop: 0,
          paddingBottom: 0,
          backgroundColor: T.panel,
        }}
      >
        <Tabs width={inner} view={view} range={range} filterText={filterText} typing={typing} onView={switchView} onRange={changeRange} />
        <SummaryLine width={inner} summary={summary} />
        <text fg={T.dim}>{pad(columns, inner)}</text>
        <box
          style={{ flexDirection: "column", height: visRows, width: inner, flexShrink: 0, backgroundColor: T.panel }}
          onMouseScroll={(e) => {
            if (e.scroll) select(cur + (e.scroll.direction === "up" ? -3 : 3));
          }}
        >
          {body}
        </box>
        <box style={{ flexDirection: "column", height: DETAIL_ROWS, width: inner, flexShrink: 0, backgroundColor: T.panel }}>
          {detail.map((r, i) => (
            <text key={`d${i}`} fg={r.color}>
              {pad(r.text, inner)}
            </text>
          ))}
        </box>
        <ActionBar width={inner} items={actions} trailing={trailing} />
        <text fg={status.color}>{pad(status.text, inner)}</text>
      </box>
      <Footer hints={hints} />
    </box>
  );
}

// --- top rows -----------------------------------------------------------------

function Tabs({
  width,
  view,
  range,
  filterText: rawFilter,
  typing,
  onView,
  onRange,
}: {
  width: number;
  view: View;
  range: RangeDays;
  filterText: string;
  typing: boolean;
  onView: (v: View) => void;
  onRange: (r: RangeDays) => void;
}) {
  const tabs = VIEWS.map((v, i) => ({ v, label: ` ${i + 1} ${v} ` }));
  const ranges = RANGES.map((r) => ({ r, label: ` ${rangeLabel(r)} ` }));
  const used = tabs.reduce((n, t) => n + t.label.length, 0) + ranges.reduce((n, r) => n + r.label.length, 0);
  const filterText = fit(rawFilter, Math.max(0, width - used - 2));
  const gap = Math.max(1, width - used - filterText.length);
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      {tabs.map((t) => (
        <box key={t.v} style={{ height: 1, width: t.label.length, backgroundColor: t.v === view ? T.selectionBg : T.panel }} onMouseDown={() => onView(t.v)}>
          <text fg={t.v === view ? ACCENT : T.dim}>{t.label}</text>
        </box>
      ))}
      <box style={{ height: 1, width: filterText.length + gap }}>
        <text fg={typing ? T.yellow : T.teal}>{pad(filterText, filterText.length + gap)}</text>
      </box>
      {ranges.map((r) => (
        <box key={r.r} style={{ height: 1, width: r.label.length, backgroundColor: r.r === range ? T.surfaceAlt : T.panel }} onMouseDown={() => onRange(r.r)}>
          <text fg={r.r === range ? T.cyan : T.dim}>{r.label}</text>
        </box>
      ))}
    </box>
  );
}

function SummaryLine({ width, summary }: { width: number; summary: Summary | null }) {
  if (!summary) return <text fg={T.dim}>{pad("", width)}</text>;
  const t = summary.total;
  const left = `${usd(t.cost)} API-equiv`;
  const rest = ` · ${tok(totalTokens(t.tokens))} tokens · ${t.sessions.toLocaleString("en-US")} sessions · ${t.projects} projects · ${hm(t.activeMin)} active · ${summary.models}`;
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <text>
        <span fg={T.fg}>{left}</span>
        <span fg={T.dim}>{pad(rest, Math.max(0, width - left.length))}</span>
      </text>
    </box>
  );
}

// --- projects -----------------------------------------------------------------

interface ProjectGeo {
  nameW: number;
  sparkW: number;
  modelsW: number;
}

function projectGeometry(inner: number): ProjectGeo {
  const sparkW = inner >= 160 ? 30 : inner >= 125 ? 21 : 14;
  const fixed = 2 + 10 + 8 + 6 + 6 + 8 + 2 + sparkW + 1 + 13 + BTN_W;
  const rest = Math.max(20, inner - fixed);
  const nameW = Math.max(14, Math.min(28, Math.floor(rest * 0.45)));
  return { nameW, sparkW, modelsW: Math.max(0, rest - nameW) };
}

function ProjectLine({
  p,
  g,
  width,
  selected,
  onHover,
  onPress,
  onOpenFolder,
}: {
  p: ProjectRow;
  g: ProjectGeo;
  width: number;
  selected: boolean;
  onHover: () => void;
  onPress: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: selected ? T.selectionBg : T.panel }} onMouseOver={onHover} onMouseDown={onPress}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={selected ? T.teal : T.fg}>{pad(p.name, g.nameW)}</span>
        <span fg={p.cost >= 100 ? T.yellow : T.fg}>{usd(p.cost).padStart(10)}</span>
        <span fg={T.dim}>{tok(totalTokens(p.tokens)).padStart(8)}</span>
        <span fg={T.fg}>{String(p.sessions).padStart(6)}</span>
        <span fg={T.dim}>{String(p.activeDays).padStart(6)}</span>
        <span fg={T.fg}>{hm(p.activeMin).padStart(8)}</span>
        <span>{"  "}</span>
        <span fg={T.cyan}>{pad(sparkline(p.series.slice(-g.sparkW)), g.sparkW + 1)}</span>
        <span fg={T.dim}>{pad(when(p.lastTs), 13)}</span>
        <span fg={T.dim}>{pad(p.models, g.modelsW)}</span>
      </text>
      <box
        style={{ width: BTN_W, height: 1, flexShrink: 0, backgroundColor: selected ? T.surfaceAlt : T.panel }}
        onMouseDown={(e) => {
          e.stopPropagation();
          onOpenFolder();
        }}
      >
        <text fg={T.teal}>{pad(" ↪", BTN_W)}</text>
      </box>
    </box>
  );
}

// --- timeline -----------------------------------------------------------------

const LABEL_W = 18;
const TOTAL_W = 10;

interface TimelineGeo {
  cellW: number;
  cols: number;
  /** First visible column index — the grid scrolls to keep the cursor in view. */
  start: number;
}

function timelineGeometry(inner: number, colCount: number, cursor: number, prevStart: number, weekly: boolean): TimelineGeo {
  const avail = Math.max(10, inner - 2 - LABEL_W - TOTAL_W);
  // As wide as the range allows, so short ranges fill the panel instead of huddling left.
  const cellW = Math.max(1, Math.min(weekly ? 12 : 4, Math.floor(avail / Math.max(1, colCount))));
  const cols = Math.min(colCount, Math.floor(avail / cellW));
  return { cellW, cols, start: windowTop(prevStart, cursor, colCount, cols) };
}

/** A project's cost and active time summed over a bucket's days. */
function bucketCell(summary: Summary, project: string, b: Bucket): { cost: number; activeMin: number } {
  const row = summary.heat.get(project);
  let cost = 0;
  let activeMin = 0;
  for (const d of b.days) {
    const cell = row?.get(d);
    cost += cell?.cost ?? 0;
    activeMin += cell?.activeMin ?? 0;
  }
  return { cost, activeMin };
}

/** Column header: an MM-DD label on each Monday (every week when weekly) and the first column, where it fits. */
function timelineHeader(cols: Bucket[], g: TimelineGeo, inner: number, weekly: boolean): string {
  const chars = Array.from({ length: g.cols * g.cellW }, () => " ");
  let freeFrom = 0;
  for (let c = 0; c < g.cols; c++) {
    const b = cols[g.start + c];
    const day = b?.days[0];
    if (!b || !day) break;
    const monday = new Date(`${day}T12:00:00`).getDay() === 1;
    const x = c * g.cellW;
    if ((c === 0 || weekly || monday) && x >= freeFrom) {
      const label = b.label;
      for (let k = 0; k < label.length && x + k < chars.length; k++) chars[x + k] = label[k] ?? " ";
      freeFrom = x + label.length + 1;
    }
  }
  const rest = Math.max(0, inner - 2 - LABEL_W - chars.length);
  return `  ${pad("project", LABEL_W)}${chars.join("")}${"total".padStart(rest)}`;
}

function HeatLine({
  p,
  summary,
  cols,
  g,
  max,
  cursor,
  width,
  selected,
  onHover,
  onPick,
}: {
  p: ProjectRow;
  summary: Summary;
  cols: Bucket[];
  g: TimelineGeo;
  max: number;
  cursor: number;
  width: number;
  selected: boolean;
  onHover: () => void;
  onPick: (col: number) => void;
}) {
  const cells = [];
  for (let c = 0; c < g.cols; c++) {
    const i = g.start + c;
    const b = cols[i];
    const cost = b ? bucketCell(summary, p.name, b).cost : 0;
    // sqrt so a $5 day is still visible next to a $1,500 one
    const level = cost <= 0 || max <= 0 ? -1 : Math.min(HEAT.length - 1, Math.floor(Math.sqrt(cost / max) * HEAT.length));
    const glyph = level < 0 ? "·" : (HEAT[level] ?? "█");
    const isCursor = i === cursor;
    cells.push(
      <box
        key={i}
        style={{ width: g.cellW, height: 1, flexShrink: 0, backgroundColor: isCursor ? (selected ? T.border : T.surface) : selected ? T.selectionBg : T.panel }}
        onMouseDown={(e) => {
          e.stopPropagation();
          onPick(i);
        }}
      >
        <text fg={level < 0 ? T.border : level >= 2 ? T.cyan : T.blue}>{g.cellW === 1 ? glyph : `${glyph.repeat(level < 0 ? 1 : g.cellW - 1).padEnd(g.cellW)}`}</text>
      </box>,
    );
  }
  const rest = Math.max(0, width - 2 - LABEL_W - g.cols * g.cellW - TOTAL_W);
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: selected ? T.selectionBg : T.panel }} onMouseOver={onHover}>
      <box style={{ width: 2 + LABEL_W, height: 1, flexShrink: 0 }}>
        <text>
          <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
          <span fg={selected ? T.teal : T.fg}>{pad(p.name, LABEL_W)}</span>
        </text>
      </box>
      {cells}
      <box style={{ width: rest + TOTAL_W, height: 1, flexShrink: 0 }}>
        <text fg={T.fg}>{usd(p.cost).padStart(rest + TOTAL_W)}</text>
      </box>
    </box>
  );
}

// --- sessions -----------------------------------------------------------------

const BTN_W = 4;

interface SessionGeo {
  projW: number;
  titleW: number;
}

function sessionGeometry(inner: number): SessionGeo {
  const fixed = 2 + 13 + 7 + 2 + 10 + 8 + 5 + BTN_W;
  const rest = Math.max(20, inner - fixed);
  const projW = Math.max(12, Math.min(20, Math.floor(rest * 0.25)));
  return { projW, titleW: rest - projW };
}

function SessionLine({ s, g, width, selected, onHover, onResume }: { s: SessionRow; g: SessionGeo; width: number; selected: boolean; onHover: () => void; onResume: () => void }) {
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: selected ? T.selectionBg : T.panel }} onMouseOver={onHover}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={T.dim}>{pad(when(s.end), 13)}</span>
        <span fg={T.fg}>{hm(s.activeMin).padStart(7)}</span>
        <span>{"  "}</span>
        <span fg={selected ? T.teal : T.fg}>{pad(s.project, g.projW)}</span>
        <span fg={s.title ? T.fg : T.dim}>{pad(s.title || s.id.slice(0, 8), g.titleW)}</span>
        <span fg={s.cost >= 50 ? T.yellow : T.fg}>{usd(s.cost).padStart(10)}</span>
        <span fg={T.dim}>{tok(totalTokens(s.tokens)).padStart(8)}</span>
        <span fg={T.dim}>{(s.subagents ? String(s.subagents) : "·").padStart(5)}</span>
      </text>
      <box
        style={{ width: BTN_W, height: 1, flexShrink: 0, backgroundColor: selected ? T.surfaceAlt : T.panel }}
        onMouseDown={(e) => {
          e.stopPropagation();
          onResume();
        }}
      >
        <text fg={T.green}>{pad(" ▶", BTN_W)}</text>
      </box>
    </box>
  );
}

// --- days ---------------------------------------------------------------------

interface DayGeo {
  projW: number;
}

function dayGeometry(inner: number): DayGeo {
  return { projW: Math.max(10, inner - (2 + 12 + 10 + 8 + 6 + 8 + 2)) };
}

function DayLine({ d, g, width, selected, onHover, onPress }: { d: DayRow; g: DayGeo; width: number; selected: boolean; onHover: () => void; onPress: () => void }) {
  const projects = d.projects.map((p) => `${p.name} ${usd(p.cost)}`).join(" · ");
  const weekend = [0, 6].includes(new Date(`${d.day}T12:00:00`).getDay());
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: selected ? T.selectionBg : T.panel }} onMouseOver={onHover} onMouseDown={onPress}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={weekend ? T.dim : T.fg}>{pad(weekdayDate(d.day), 12)}</span>
        <span fg={d.cost >= 500 ? T.yellow : T.fg}>{usd(d.cost).padStart(10)}</span>
        <span fg={T.fg}>{hm(d.activeMin).padStart(8)}</span>
        <span fg={T.dim}>{String(d.sessions).padStart(6)}</span>
        <span fg={T.dim}>{tok(totalTokens(d.tokens)).padStart(8)}</span>
        <span>{"  "}</span>
        <span fg={selected ? T.fg : T.dim}>{pad(projects, g.projW)}</span>
      </text>
    </box>
  );
}
