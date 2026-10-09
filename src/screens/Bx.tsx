import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ActionBar, btn, seg, type BarItem } from "../components/ActionBar.tsx";
import { Footer } from "../components/Footer.tsx";
import { fit, pad, wrap } from "../lib/text.ts";
import { prettyCommand } from "../lib/proctext.ts";
import {
  BxSampler,
  driversOf,
  forceGc,
  heapSnapshot,
  killOrphan,
  killTree,
  logPath,
  readLogTail,
  sparkline,
  stopDaemon,
  type BxScan,
  type ChromeKind,
  type Daemon,
  type Driver,
  type Orphan,
  type Series,
  type TreeProc,
} from "../lib/bx.ts";
import { profilesTotal } from "../lib/bxProfiles.ts";

// bx daemons (G:\code\bx): one item per daemon — what it's doing, who's
// driving it, what it costs and whether that's growing — then whatever bx
// left behind. The detail pane is the debugger: memory history, pages with
// Chrome's own counters, the command journal, the process tree, the log.
// Data comes from lib/bx.ts (run files + GET /debug + the bun:ffi process table).

const ACCENT = T.teal;
const SCAN_MS = 2000;
const ARM_MS = 3000;
const FLASH_MS = 6000;
const TREND_W = 10;
const TREND_MS = 10 * 60_000;

/** A sparkline over up to TREND_MS — less while history is short, so a fresh screen already shows a shape. */
function trend(series: Series, now: number): string {
  const first = series.t[0];
  const span = first === undefined ? TREND_MS : Math.min(TREND_MS, Math.max(TREND_W * SCAN_MS, now - first));
  return sparkline(series.buckets(TREND_W, span, now));
}
const WIDE = 120;

type View = "overview" | "pages" | "activity" | "procs" | "log";
const VIEWS: readonly View[] = ["overview", "pages", "activity", "procs", "log"];
type Mem = "commit" | "ws";

type Item = { kind: "daemon"; id: string; d: Daemon } | { kind: "orphan"; id: string; o: Orphan };

type ArmTarget = { kind: "stop" | "kill"; id: string } | { kind: "orphans" };

interface Armed {
  target: ArmTarget;
  until: number;
}

interface Flash {
  text: string;
  color: string;
  until: number;
}

interface Props {
  back: () => void;
  /** opens the bx profiles screen (disk use + prune) */
  profiles: () => void;
  /** start with the memlog on (`destedtui --bx --log`) */
  log?: boolean;
}

function sameTarget(a: ArmTarget, b: ArmTarget): boolean {
  if (a.kind === "orphans" || b.kind === "orphans") return a.kind === b.kind;
  return a.kind === b.kind && a.id === b.id;
}

export function Bx({ back, profiles, log }: Props) {
  const sampler = useRef(new BxSampler());
  const [scan, setScan] = useState<BxScan | null>(null);
  const [logging, setLogging] = useState<string | null>(() => (log ? sampler.current.setLogging(true) : null));
  const [mem, setMem] = useState<Mem>("commit");
  const [view, setView] = useState<View>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const lastIndex = useRef(0);
  const alive = useRef(true);
  const { width, height } = useTerminalDimensions();

  const rescan = () =>
    void sampler.current.scan().then((s) => {
      if (alive.current) setScan(s);
    });

  useEffect(() => {
    alive.current = true;
    rescan();
    // The first scan has no cpu rates yet; a quick second one fills them in.
    const second = setTimeout(rescan, 700);
    const t = setInterval(rescan, SCAN_MS);
    return () => {
      alive.current = false;
      clearTimeout(second);
      clearInterval(t);
    };
  }, []);

  // The spinner only runs while an action does (ui.md: motion = spinner only).
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [working]);

  const now = Date.now();
  if (armed && armed.until < now) setArmed(null);
  if (flash && flash.until < now) setFlash(null);

  const items: Item[] = useMemo(
    () =>
      scan
        ? [
            ...scan.daemons.map((d): Item => ({ kind: "daemon", id: d.key, d })),
            ...scan.orphans.map((o): Item => ({ kind: "orphan", id: o.key, o })),
          ]
        : [],
    [scan],
  );

  // --- geometry ---------------------------------------------------------------
  const wide = width >= WIDE;
  const showList = wide || !detailOpen;
  const showDetail = wide || detailOpen;
  const listWidth = wide ? Math.max(70, Math.min(width - 62, Math.floor(width * 0.48))) : width - 2;
  const detailWidth = wide ? width - listWidth - 3 : width - 2;
  const inner = listWidth - 4;
  // header 3 + border 2 + summary, action bar, status + margin 1 + footer 1
  const visLines = Math.max(4, height - 10);
  const visItems = Math.max(2, Math.floor(visLines / 2));
  const nameW = Math.min(20, Math.max(8, ...items.map((i) => (i.kind === "daemon" ? i.d.profile : i.o.profile).length + 2)));

  const count = items.length;
  const found = selectedId === null ? -1 : items.findIndex((r) => r.id === selectedId);
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, count - 1));
  lastIndex.current = index;
  const current = items[index] ?? null;
  const maxTop = Math.max(0, count - visItems);
  const topItem = Math.min(Math.max(Math.min(top, maxTop), index - visItems + 1), index);
  const windowItems = items.slice(topItem, topItem + visItems);

  useEffect(() => {
    if (topItem !== top) setTop(topItem);
  }, [topItem, top]);

  const select = (i: number) => {
    const r = items[Math.min(Math.max(0, i), count - 1)];
    if (r) setSelectedId(r.id);
  };

  const say = (text: string, color: string) => setFlash({ text, color, until: Date.now() + FLASH_MS });

  /** One action at a time, with the spinner, a rescan after, and its outcome in the status line. */
  const act = (label: string, job: () => Promise<{ text: string; color: string }>) => {
    if (working) return;
    setWorking(label);
    void job()
      .catch((err: unknown) => ({ text: `✗ ${err instanceof Error ? err.message : String(err)}`, color: T.red }))
      .then((r) => {
        if (!alive.current) return;
        setWorking(null);
        say(r.text, r.color);
        rescan();
      });
  };

  /** First press arms, the second within ARM_MS fires. */
  const arm = (t: ArmTarget, fire: () => void) => {
    if (working) return;
    if (!armed || !sameTarget(armed.target, t)) {
      setArmed({ target: t, until: Date.now() + ARM_MS });
      return;
    }
    setArmed(null);
    fire();
  };

  const stop = (d: Daemon) =>
    arm({ kind: "stop", id: d.key }, () =>
      act(`stopping ${d.profile}`, async () =>
        (await stopDaemon(d)) === "stopped"
          ? { text: `■ stopped ${d.profile} — its Chrome closed and the run file is gone`, color: T.green }
          : { text: `✕ ${d.profile} didn't answer /shutdown — killed its process tree`, color: T.yellow },
      ),
    );

  const killDaemonTree = (d: Daemon) =>
    arm({ kind: "kill", id: d.key }, () =>
      act(`killing ${d.profile}`, async () => {
        await killTree(d.run.pid);
        return { text: `✕ killed ${d.profile}: ${d.tree.length} processes`, color: T.green };
      }),
    );

  const killOne = (o: Orphan) =>
    arm({ kind: "kill", id: o.key }, () =>
      act(`cleaning up ${o.profile}`, async () => {
        await killOrphan(o);
        return { text: o.kind === "runfile" ? `✓ cleared ${o.profile}'s stale run file` : `✓ killed ${o.profile}: ${o.tree.length} processes`, color: T.green };
      }),
    );

  const orphans = scan?.orphans ?? [];
  const killAllOrphans = () => {
    if (orphans.length === 0) return say("no orphans", T.dim);
    arm({ kind: "orphans" }, () =>
      act(`cleaning up ${orphans.length} orphans`, async () => {
        for (const o of orphans) await killOrphan(o);
        return { text: `✓ cleaned up ${orphans.length} orphan${orphans.length === 1 ? "" : "s"}`, color: T.green };
      }),
    );
  };

  const gc = (d: Daemon) =>
    act(`gc on ${d.profile}`, async () => {
      const r = await forceGc(d);
      if (typeof r === "string") return { text: `✗ gc: ${r}`, color: T.red };
      if (!r.ran) return { text: `gc isn't exposed in ${d.profile} — it started before bx passed --expose-gc; stop it and it comes back with it`, color: T.yellow };
      return { text: `⟳ gc ${d.profile}: heap ${fmtBytes(r.heapBefore)} → ${fmtBytes(r.heapAfter)} (${fmtSigned(r.heapAfter - r.heapBefore)})`, color: T.green };
    });

  const snapshot = (d: Daemon) =>
    act(`heap snapshot of ${d.profile} (the daemon pauses)`, async () => {
      const r = await heapSnapshot(d);
      if (typeof r === "string") return { text: `✗ heap snapshot: ${r}`, color: T.red };
      return { text: `⛁ ${r.path} (${fmtBytes(r.bytes)}, ${fmtDur(r.ms)}) — load it in DevTools › Memory`, color: T.green };
    });

  const toggleLog = () => {
    const path = sampler.current.setLogging(!logging);
    setLogging(path);
    say(path ? `⏺ memlog on → ${path}` : "⏹ memlog off", path ? T.yellow : T.dim);
  };

  const rowAction = (item: Item | null) => {
    if (!item) return;
    if (item.kind === "daemon") stop(item.d);
    else killOne(item.o);
  };

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (key.name === "escape") {
      if (armed) return setArmed(null);
      if (!wide && detailOpen) return setDetailOpen(false);
      return back();
    }
    if (key.name === "up") return select(index - 1);
    if (key.name === "down") return select(index + 1);
    if (key.name === "pageup") return select(index - visItems);
    if (key.name === "pagedown") return select(index + visItems);
    if (key.name === "home") return select(0);
    if (key.name === "end") return select(count - 1);
    if (key.name === "return" || key.name === "space") {
      if (!wide) setDetailOpen((o) => !o);
      return;
    }
    if (key.name === "tab") {
      const i = VIEWS.indexOf(view);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length] ?? "overview");
    }
    if (key.name === "x" && key.shift) return killAllOrphans();
    const d = current?.kind === "daemon" ? current.d : null;
    switch (key.sequence) {
      case "x":
        return rowAction(current);
      case "k":
        return d ? killDaemonTree(d) : undefined;
      case "g":
        return d ? gc(d) : undefined;
      case "h":
        return d ? snapshot(d) : undefined;
      case "l":
        return toggleLog();
      case "p":
        return profiles();
      case "m":
        return setMem((m) => (m === "commit" ? "ws" : "commit"));
      case "r":
        rescan();
        return say("↻ rescanned", T.dim);
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
        return setView(VIEWS[Number(key.sequence) - 1] ?? "overview");
    }
  });

  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
  const orphansArmed = armed?.target.kind === "orphans";
  const diskTotal = profilesTotal();
  const actions: BarItem[] = [
    seg("mem", ["commit", "ws"] as const, mem, setMem),
    btn(logging ? "⏺ memlog on" : "⏺ memlog", logging ? T.yellow : T.cyan, toggleLog),
    btn(diskTotal ? `⛁ profiles ${fmtBytes(diskTotal.bytes)}` : "⛁ profiles", T.cyan, profiles),
  ];
  if (orphans.length > 0) {
    actions.push(btn(orphansArmed ? `✕? clean up ${orphans.length}` : `✕ orphans (${orphans.length})`, T.red, killAllOrphans));
  }
  const trailing: BarItem[] = [
    btn("↻ rescan", T.cyan, () => {
      rescan();
      say("↻ rescanned", T.dim);
    }),
    armed ? btn("✕ cancel", T.dim, () => setArmed(null)) : btn("← back", T.dim, back),
  ];

  const armedFor = (kind: "stop" | "kill", id: string) => armed !== null && armed.target.kind === kind && armed.target.id === id;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        {showList && (
          <box
            title=" bx daemons "
            style={{
              width: listWidth,
              flexShrink: 0,
              flexDirection: "column",
              border: true,
              borderStyle: "rounded",
              borderColor: armed ? T.red : T.border,
              titleColor: ACCENT,
              margin: 1,
              marginTop: 0,
              marginRight: 0,
              padding: 1,
              paddingTop: 0,
              paddingBottom: 0,
              backgroundColor: T.panel,
            }}
          >
            <Summary width={inner} scan={scan} now={now} />
            <box
              style={{ flexDirection: "column", height: visLines, width: inner, flexShrink: 0, backgroundColor: T.panel }}
              onMouseScroll={(e) => {
                if (e.scroll) select(index + (e.scroll.direction === "up" ? -1 : 1));
              }}
            >
              {count === 0 ? (
                <EmptyList width={inner} scan={scan} />
              ) : (
                windowItems.map((item) => {
                  const selected = item === current;
                  const hover = () => setSelectedId(item.id);
                  const open = () => {
                    setSelectedId(item.id);
                    if (!wide) setDetailOpen(true);
                  };
                  if (item.kind === "daemon")
                    return (
                      <DaemonItem
                        key={item.id}
                        d={item.d}
                        width={inner}
                        nameW={nameW}
                        mem={mem}
                        now={now}
                        selected={selected}
                        armed={armedFor("stop", item.id)}
                        onHover={hover}
                        onOpen={open}
                        onStop={() => {
                          setSelectedId(item.id);
                          stop(item.d);
                        }}
                      />
                    );
                  return (
                    <OrphanItem
                      key={item.id}
                      o={item.o}
                      width={inner}
                      nameW={nameW}
                      selected={selected}
                      armed={armedFor("kill", item.id) || orphansArmed}
                      onHover={hover}
                      onOpen={open}
                      onKill={() => {
                        setSelectedId(item.id);
                        killOne(item.o);
                      }}
                    />
                  );
                })
              )}
            </box>
            <ActionBar width={inner} items={actions} trailing={trailing} />
            <StatusLine
              width={inner}
              armed={armed}
              items={items}
              flash={flash}
              working={working}
              spin={spin}
              logging={logging}
              range={count > visItems ? `${topItem + 1}–${Math.min(count, topItem + visItems)} of ${count} · ` : ""}
            />
          </box>
        )}
        {showDetail && (
          <Detail
            item={current}
            view={view}
            setView={setView}
            width={detailWidth}
            height={height - 5}
            now={now}
            armedFor={armedFor}
            busy={working !== null}
            onGc={gc}
            onSnapshot={snapshot}
            onKillTree={killDaemonTree}
            onStop={stop}
            onKillOrphan={killOne}
            onClose={wide ? null : () => setDetailOpen(false)}
          />
        )}
      </box>
      <Footer
        hints={[
          ["click", "anything"],
          ["↑↓", "select"],
          ["tab", "view"],
          ["x", armed ? "again to confirm" : "stop / clean up"],
          ["esc", armed ? "disarm" : !wide && detailOpen ? "list" : "back"],
        ]}
      />
    </box>
  );
}

// ─── list ─────────────────────────────────────────────────────────────────────

function Summary({ width, scan, now }: { width: number; scan: BxScan | null; now: number }) {
  if (!scan) return <text fg={T.dim}>{pad("scanning bx daemons…", width)}</text>;
  if (scan.error) return <text fg={T.red}>{pad(scan.error, width)}</text>;
  const t = scan.totals;
  const n = scan.daemons.length;
  const head = `${n} daemon${n === 1 ? "" : "s"} · ${t.chromeProcs} chrome · ${fmtBytes(t.ws)} ws · ${fmtBytes(t.commit)} commit · cpu ${fmtCpu(t.cpu)}  `;
  const slope = scan.hist.slopePerMin();
  const spark = trend(scan.hist, now);
  const rate = ` ${fmtRate(slope)}`;
  const orphanText = scan.orphans.length ? `  ⚠ ${scan.orphans.length} orphan${scan.orphans.length === 1 ? "" : "s"}` : "";
  return <LineView width={width} line={{ segs: [[head, T.fg], [spark, T.cyan], [rate, growthColor(slope, "tree")], [orphanText, T.orange]] }} />;
}

function EmptyList({ width, scan }: { width: number; scan: BxScan | null }) {
  if (!scan) return <text fg={T.dim}>{pad("", width)}</text>;
  return (
    <box style={{ flexDirection: "column", width }}>
      <text fg={T.dim}>{pad("No bx daemons running.", width)}</text>
      <text fg={T.dim}>{pad("bx starts one per profile on its first command (bx --profile <name> open <url>).", width)}</text>
    </box>
  );
}

interface State {
  glyph: string;
  color: string;
  text: string;
}

function stateOf(d: Daemon, now: number): State {
  if (d.debugError === "old") return { glyph: "◌", color: T.orange, text: "old daemon: no /debug, stop it to see inside" };
  if (d.debugError === "down") return { glyph: "✕", color: T.red, text: "not answering" };
  const dbg = d.debug;
  if (!dbg) return { glyph: "◌", color: T.dim, text: d.debugError === "busy" ? "slow to answer /debug" : "reading…" };
  const slow = d.debugError === "busy" ? " (slow)" : "";
  if (dbg.recording) return { glyph: "◉", color: T.red, text: `recording ${dbg.recording}${slow}` };
  const first = [...dbg.inFlight].sort((a, b) => a.startedAt - b.startedAt)[0];
  if (first) {
    const more = dbg.inFlight.length > 1 ? ` +${dbg.inFlight.length - 1}` : "";
    return { glyph: "●", color: T.yellow, text: `${fmtDur(now - first.startedAt)} ${first.summary}${more}${slow}` };
  }
  if (!dbg.browserRunning) return { glyph: "○", color: T.dim, text: `no browser${slow}` };
  return { glyph: "●", color: T.green, text: `idle ${fmtAgo(dbg.idle.lastActivityAt, now)}${slow}` };
}

const UP_W = 5;
const BTN_W = 9;

function DaemonItem({
  d,
  width,
  nameW,
  mem,
  now,
  selected,
  armed,
  onHover,
  onOpen,
  onStop,
}: {
  d: Daemon;
  width: number;
  nameW: number;
  mem: Mem;
  now: number;
  selected: boolean;
  armed: boolean;
  onHover: () => void;
  onOpen: () => void;
  onStop: () => void;
}) {
  const st = stateOf(d, now);
  const bg = armed ? T.surface : selected ? T.selectionBg : T.panel;
  const stateW = Math.max(4, width - 2 - 2 - nameW - UP_W - 1 - BTN_W);
  const up = fmtAgo(Date.parse(d.run.startedAt), now);

  const series = mem === "commit" ? d.hist.commit : d.hist.ws;
  const slope = series.slopePerMin();
  const node = mem === "commit" ? d.mem.nodeCommit : d.mem.nodeWs;
  const chrome = mem === "commit" ? d.mem.chromeCommit : d.mem.chromeWs;
  const nodeText = `node ${fmtBytes(node)}`.padEnd(11);
  const chromeText = `chrome ${fmtBytes(chrome)} ×${d.mem.chromeProcs}`.padEnd(18);
  const spark = trend(series, now);
  const rate = ` ${fmtRate(slope)}`.padEnd(9);
  const cpu = `cpu ${fmtCpu(d.cpu.node + d.cpu.chrome)}`.padEnd(9);
  const driver = driversOf(d.debug)[0];
  const who = driver ? `by ${driver.label}` : "";

  return (
    <box style={{ flexDirection: "column", height: 2, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={onOpen}>
      <box style={{ flexDirection: "row", height: 1, width }}>
        <LineView
          width={width - BTN_W + 1}
          line={{
            segs: [
              [selected ? "❯ " : "  ", selected ? ACCENT : T.dim],
              [`${st.glyph} `, st.color],
              [pad(d.profile, nameW), armed ? T.red : T.fg, true],
              [pad(st.text, stateW), st.color === T.green ? T.dim : st.color],
              [up.padStart(UP_W), T.dim],
              [" ", T.dim],
            ],
          }}
        />
        <RowButton label={armed ? "■? stop" : "■ stop"} width={BTN_W - 1} hot={armed} onPress={onStop} />
      </box>
      <LineView
        width={width}
        line={{
          segs: [
            ["    ", T.dim],
            [nodeText, memColor(node)],
            [chromeText, memColor(chrome)],
            [spark, T.cyan],
            [rate, growthColor(slope, "tree")],
            [cpu, cpuColor(d.cpu.node + d.cpu.chrome)],
            [who, T.dim],
          ],
        }}
      />
    </box>
  );
}

function orphanText(o: Orphan): string {
  if (o.kind === "daemon") return "daemon with no run file — nothing can reach it";
  if (o.kind === "chrome") return "Chrome left behind — its daemon is gone";
  return "stale run file — its daemon is gone";
}

function OrphanItem({
  o,
  width,
  nameW,
  selected,
  armed,
  onHover,
  onOpen,
  onKill,
}: {
  o: Orphan;
  width: number;
  nameW: number;
  selected: boolean;
  armed: boolean;
  onHover: () => void;
  onOpen: () => void;
  onKill: () => void;
}) {
  const bg = armed ? T.surface : selected ? T.selectionBg : T.panel;
  const textW = Math.max(4, width - 2 - 2 - nameW - BTN_W);
  const label = o.kind === "runfile" ? (armed ? "✕? clear" : "✕ clear") : armed ? "✕? kill" : "✕ kill";
  const second =
    o.kind === "runfile"
      ? `    ${o.runPath ?? ""}`
      : `    ${o.tree.length} procs · ${fmtBytes(o.memory)} ws · ${fmtBytes(o.commit)} commit · cpu ${fmtCpu(o.cpu)}${o.root ? ` · up ${fmtAgo(o.root.startedAt, Date.now())}` : ""}`;
  return (
    <box style={{ flexDirection: "column", height: 2, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={onOpen}>
      <box style={{ flexDirection: "row", height: 1, width }}>
        <LineView
          width={width - BTN_W + 1}
          line={{
            segs: [
              [selected ? "❯ " : "  ", selected ? ACCENT : T.dim],
              ["⚠ ", T.orange],
              [pad(o.profile, nameW), armed ? T.red : T.orange, true],
              [pad(orphanText(o), textW), T.dim],
              [" ", T.dim],
            ],
          }}
        />
        <RowButton label={label} width={BTN_W - 1} hot={armed} onPress={onKill} />
      </box>
      <text fg={T.dim}>{pad(second, width)}</text>
    </box>
  );
}

export function RowButton({ label, width, hot, onPress }: { label: string; width: number; hot: boolean; onPress: () => void }) {
  return (
    <box
      style={{ width, height: 1, flexShrink: 0, backgroundColor: hot ? T.red : T.surfaceAlt }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onPress();
      }}
    >
      <text fg={hot ? T.bg : T.red}>{pad(` ${label}`, width)}</text>
    </box>
  );
}

function StatusLine({
  width,
  armed,
  items,
  flash,
  working,
  spin,
  logging,
  range,
}: {
  width: number;
  armed: Armed | null;
  items: Item[];
  flash: Flash | null;
  working: string | null;
  spin: string;
  logging: string | null;
  range: string;
}) {
  if (working) return <text fg={T.yellow}>{pad(`${spin} ${working}…`, width)}</text>;
  if (armed) {
    const t = armed.target;
    let text: string;
    if (t.kind === "orphans") {
      const n = items.filter((i) => i.kind === "orphan").length;
      text = `⚠ clean up ${n} orphan${n === 1 ? "" : "s"}: kill leftover trees, clear stale run files — press again`;
    } else {
      const item = items.find((i) => i.id === t.id);
      if (item?.kind === "daemon") {
        const d = item.d;
        text =
          t.kind === "stop"
            ? `⚠ stop ${d.profile}: asks the daemon to close Chrome and exit${d.debug?.inFlight.length ? ` — ${d.debug.inFlight.length} command(s) in flight die` : ""} — press again`
            : `⚠ kill ${d.profile}'s whole tree: ${d.tree.length} processes, no clean shutdown — press again`;
      } else if (item?.kind === "orphan") {
        text = item.o.kind === "runfile" ? `⚠ delete ${item.o.runPath ?? "the run file"} — press again` : `⚠ kill ${item.o.profile}: ${item.o.tree.length} processes, ${fmtBytes(item.o.commit)} commit — press again`;
      } else text = "⚠ press again";
    }
    return <text fg={T.red}>{pad(text, width)}</text>;
  }
  if (flash) return <text fg={flash.color}>{pad(flash.text, width)}</text>;
  if (logging) return <text fg={T.yellow}>{pad(`${range}⏺ memlog → ${logging}`, width)}</text>;
  return <text fg={T.dim}>{pad(`${range}live every ${SCAN_MS / 1000}s · trend = up to 10 min · growth = slope over 5 min · cpu = % of one core`, width)}</text>;
}

// ─── detail pane ──────────────────────────────────────────────────────────────

export type Seg = [text: string, color: string, bold?: boolean];
export interface Line {
  segs: Seg[];
  bold?: boolean;
}

function lineBuilder() {
  const lines: Line[] = [];
  return {
    lines,
    add: (text: string, color: string = T.fg, bold = false) => lines.push({ segs: [[text, color]], bold }),
    segs: (...segs: Seg[]) => lines.push({ segs }),
    blank: () => lines.push({ segs: [["", T.dim]] }),
  };
}

export function LineView({ line, width }: { line: Line; width: number }) {
  let used = 0;
  const parts = line.segs.map(([text, color, bold], i) => {
    const last = i === line.segs.length - 1;
    const room = Math.max(0, width - used);
    const t = last ? pad(text, room) : fit(text, room);
    used += t.length;
    return (
      <span key={i} fg={color}>
        {bold ? <strong>{t}</strong> : t}
      </span>
    );
  });
  if (used < width) parts.push(<span key="pad">{" ".repeat(width - used)}</span>);
  return <text>{line.bold ? <strong>{parts}</strong> : parts}</text>;
}

function Detail({
  item,
  view,
  setView,
  width,
  height,
  now,
  armedFor,
  busy,
  onGc,
  onSnapshot,
  onKillTree,
  onStop,
  onKillOrphan,
  onClose,
}: {
  item: Item | null;
  view: View;
  setView: (v: View) => void;
  width: number;
  height: number;
  now: number;
  armedFor: (kind: "stop" | "kill", id: string) => boolean;
  busy: boolean;
  onGc: (d: Daemon) => void;
  onSnapshot: (d: Daemon) => void;
  onKillTree: (d: Daemon) => void;
  onStop: (d: Daemon) => void;
  onKillOrphan: (o: Orphan) => void;
  onClose: (() => void) | null;
}) {
  const inner = width - 4;
  // panel height - border 2 - bottom padding 1 - view row - action row
  const room = Math.max(3, height - 5);
  const panel = {
    width,
    height,
    flexShrink: 0,
    flexDirection: "column" as const,
    border: true,
    borderStyle: "rounded" as const,
    borderColor: item ? ACCENT : T.border,
    titleColor: ACCENT,
    margin: 1,
    marginTop: 0,
    padding: 1,
    paddingTop: 0,
    backgroundColor: T.panel,
  };
  const close: BarItem[] = onClose ? [btn("← list", T.dim, onClose)] : [];

  if (!item) {
    return (
      <box title=" details " style={{ ...panel, borderColor: T.border }}>
        <text fg={T.dim}>{pad("nothing selected", inner)}</text>
      </box>
    );
  }

  let lines: Line[];
  let actions: BarItem[];
  let title: string;
  if (item.kind === "daemon") {
    const d = item.d;
    title = ` ${d.profile} `;
    actions = [
      btn("⟳ gc", T.green, () => onGc(d)),
      btn("⛁ heap snapshot", T.blue, () => onSnapshot(d)),
      btn(armedFor("kill", d.key) ? "✕? kill tree" : "✕ kill tree", T.red, () => onKillTree(d)),
    ];
    // On a narrow terminal the detail replaces the list, so the row's stop button lives here too.
    if (onClose) actions.push(btn(armedFor("stop", d.key) ? "■? stop" : "■ stop", T.red, () => onStop(d)));
    lines =
      view === "overview"
        ? overviewLines(d, inner, now)
        : view === "pages"
          ? pageLines(d, now)
          : view === "activity"
            ? activityLines(d, now)
            : view === "procs"
              ? treeLines(d.tree, inner)
              : logLines(d.profile, inner, room);
  } else {
    const o = item.o;
    title = ` ${o.profile} · orphan `;
    const armedHere = armedFor("kill", o.key);
    actions = [btn(o.kind === "runfile" ? (armedHere ? "✕? clear run file" : "✕ clear run file") : armedHere ? "✕? kill tree" : "✕ kill tree", T.red, () => onKillOrphan(o))];
    lines = view === "log" ? logLines(o.profile, inner, room) : orphanLines(o, inner);
  }

  const shown = lines.slice(0, room);
  if (lines.length > room) shown[shown.length - 1] = { segs: [[`… ${lines.length - room + 1} more lines`, T.dim]] };

  return (
    <box title={title} style={panel}>
      <ActionBar width={inner} items={[seg("", VIEWS, view, setView)]} trailing={close} />
      <ActionBar width={inner} items={busy ? [] : actions} trailing={[]} />
      {shown.map((l, i) => (
        <LineView key={i} line={l} width={inner} />
      ))}
    </box>
  );
}

function memRow(b: ReturnType<typeof lineBuilder>, label: string, value: number | null, series: Series | null, now: number, scale: Scale, note = "") {
  if (value === null) return;
  const slope = series?.slopePerMin() ?? null;
  b.segs(
    [pad(label, 15), T.dim],
    [fmtBytes(value).padStart(7), memColor(value)],
    ["  ", T.dim],
    [series ? trend(series, now) : " ".repeat(TREND_W), T.cyan],
    [`  ${fmtRate(slope)}`.padEnd(11), growthColor(slope, scale)],
    [note, T.dim],
  );
}

function overviewLines(d: Daemon, width: number, now: number): Line[] {
  const b = lineBuilder();
  const dbg = d.debug;
  const st = stateOf(d, now);
  b.segs(
    [d.profile, T.fg],
    [`  pid ${d.run.pid} · up ${fmtAgo(Date.parse(d.run.startedAt), now)} · ${d.run.headless ? "headless" : "headed"}${dbg ? ` · node ${dbg.node.version}` : ""}`, T.dim],
  );
  b.segs([`${st.glyph} `, st.color], [st.text, st.color === T.green ? T.fg : st.color]);
  if (dbg && dbg.inFlight.length === 0 && !dbg.recording && dbg.idle.limitMs > 0) {
    const left = dbg.idle.lastActivityAt + dbg.idle.limitMs - now;
    b.add(`  exits after ${Math.round(dbg.idle.limitMs / 60_000)} min idle — ${left > 0 ? `in ${fmtDur(left)}` : "any moment"} (reading /debug doesn't count as activity)`, T.dim);
  }
  if (d.debugError === "old") {
    for (const l of wrap("This daemon started before bx had /debug, so only OS numbers show here. Stop it (■ stop) and bx starts a fresh one, with /debug and --expose-gc, on its next command.", width)) b.add(l, T.orange);
  }
  if (d.debugError === "busy" && dbg) b.add(`  /debug didn't answer this scan — showing data from ${fmtAgo(d.debugAt, now)} ago`, T.yellow);
  b.blank();

  const drivers = driversOf(dbg);
  if (drivers.length) {
    b.add("driven by", T.dim);
    for (const x of drivers.slice(0, 3)) driverLine(b, x, now);
    if (drivers.length > 3) b.add(`  + ${drivers.length - 3} more`, T.dim);
    b.blank();
  }

  b.segs([pad("memory", 15), T.dim], ["now".padStart(7), T.dim], ["  trend     ", T.dim], ["  growth/min", T.dim]);
  memRow(b, "total commit", d.mem.nodeCommit + d.mem.chromeCommit, d.hist.commit, now, "tree");
  memRow(b, "total ws", d.mem.nodeWs + d.mem.chromeWs, d.hist.ws, now, "tree");
  memRow(b, "chrome commit", d.mem.chromeCommit, d.hist.chromeCommit, now, "tree", `  ${d.mem.chromeProcs} procs`);
  memRow(b, "chrome ws", d.mem.chromeWs, d.hist.chromeWs, now, "tree");
  if (dbg) {
    memRow(b, "node rss", dbg.node.rss, d.hist.nodeRss, now, "tree");
    memRow(b, "node heap", dbg.node.heapUsed, d.hist.nodeHeap, now, "page", `  of ${fmtBytes(dbg.node.heapTotal)} · ext ${fmtBytes(dbg.node.external)}`);
  } else {
    memRow(b, "node commit", d.mem.nodeCommit, null, now, "tree");
  }
  b.segs(
    [pad("cpu", 15), T.dim],
    [`node ${fmtCpu(d.cpu.node)} · chrome ${fmtCpu(d.cpu.chrome)}`, cpuColor(d.cpu.node + d.cpu.chrome)],
    [dbg ? ` · event loop p99 ${dbg.node.loopDelayMs.p99}ms, max ${dbg.node.loopDelayMs.max}ms` : "", dbg && dbg.node.loopDelayMs.p99 > 100 ? T.yellow : T.dim],
  );
  if (!dbg) return b.lines;
  b.blank();

  const t = dbg.totals;
  b.segs([pad("commands", 15), T.dim], [`${fmtCount(t.commands)}`, T.fg], [` · ${t.errors} error${t.errors === 1 ? "" : "s"}`, t.errors ? T.red : T.dim], [` · ${dbg.inFlight.length} in flight`, dbg.inFlight.length ? T.yellow : T.dim]);
  const slowest = Object.entries(t.byCmd)
    .map(([cmd, s]) => ({ cmd, avg: s.n ? s.ms / s.n : 0, n: s.n }))
    .sort((a, b2) => b2.n - a.n)
    .slice(0, 5)
    .map((s) => `${s.cmd} ×${s.n} ${fmtDur(Math.round(s.avg))}`)
    .join(" · ");
  if (slowest) b.add(`${pad("", 15)}${slowest}`, T.dim);
  const i = dbg.internals;
  const capNote =
    i.actionLogCap === undefined
      ? "  never trimmed (daemon predates the cap)"
      : `  keeps ${fmtCount(i.actionLogCap)}${i.actionLogDropped ? ` · ${fmtCount(i.actionLogDropped)} trimmed` : ""}`;
  const logHeavy = i.actionLogCap === undefined ? i.actionLog >= 10_000 : i.actionLog > i.actionLogCap;
  b.segs([pad("action log", 15), T.dim], [`${fmtCount(i.actionLog)} entries · ${fmtCount(i.actionLogChars)} chars`, logHeavy ? T.yellow : T.fg], [capNote, T.dim]);
  b.segs([pad("refs", 15), T.dim], [`${fmtCount(i.refEntries)} on ${i.refPages} page${i.refPages === 1 ? "" : "s"}`, T.fg]);
  b.segs([pad("rings", 15), T.dim], [`console ${fmtCount(i.consolePushed)} · net ${fmtCount(i.netPushed)} pushed`, T.fg], [`  (each keeps ${i.ringCap})`, T.dim]);
  b.segs([pad("gc", 15), T.dim], [dbg.node.gcExposed ? "exposed — ⟳ gc forces a full collection" : "not exposed (started without --expose-gc)", dbg.node.gcExposed ? T.dim : T.yellow]);
  return b.lines;
}

function driverLine(b: ReturnType<typeof lineBuilder>, x: Driver, now: number) {
  b.segs(["  ", T.dim], [x.label, T.fg], [`  ${x.detail}${x.via ? ` · bx ${x.via}` : ""} · ${fmtCount(x.commands)} cmds · ${fmtAgo(x.lastSeen, now)} ago`, T.dim]);
}

function pageLines(d: Daemon, now: number): Line[] {
  const b = lineBuilder();
  const dbg = d.debug;
  if (!dbg) {
    b.add(d.debugError === "old" ? "No page data: this daemon predates /debug — stop it to get it." : "No page data yet.", T.dim);
    return b.lines;
  }
  if (!dbg.browserRunning || dbg.pages.length === 0) {
    b.add("No browser open — it launches on the first page command.", T.dim);
    return b.lines;
  }
  for (const p of dbg.pages) {
    b.segs([p.active ? "● " : "○ ", p.active ? ACCENT : T.dim], [`tab ${p.tab}  `, T.dim], [p.title || "(untitled)", T.fg]);
    b.add(`  ${p.url}`, T.dim);
    const m = p.metrics;
    const h = d.hist.pages.get(p.tab);
    if (!m) {
      b.add("  no answer from the page this scan (busy main thread, or navigating)", T.yellow);
    } else {
      const heapSlope = h?.heap.slopePerMin() ?? null;
      const nodeSlope = h?.nodes.slopePerMin() ?? null;
      b.segs(
        ["  heap ", T.dim],
        [fmtBytes(m.jsHeapUsed), memColor(m.jsHeapUsed)],
        [" ", T.dim],
        [h ? trend(h.heap, now) : "", T.cyan],
        [` ${fmtRate(heapSlope)}`, growthColor(heapSlope, "page")],
        [`   nodes ${fmtCount(m.nodes)}`, T.fg],
        [nodeSlope !== null && Math.abs(nodeSlope) >= 1 ? ` ${nodeSlope > 0 ? "+" : "−"}${fmtCount(Math.round(Math.abs(nodeSlope)))}/m` : "", nodeSlope !== null && nodeSlope >= 100 ? T.yellow : T.dim],
      );
      b.add(`  listeners ${fmtCount(m.listeners)} · documents ${m.documents} · frames ${m.frames} · refs ${p.refs} · layouts ${fmtCount(m.layoutCount)} · script ${fmtDur(m.scriptMs)}`, T.dim);
    }
    b.blank();
  }
  return b.lines;
}

function activityLines(d: Daemon, now: number): Line[] {
  const b = lineBuilder();
  const dbg = d.debug;
  if (!dbg) {
    b.add(d.debugError === "old" ? "No journal: this daemon predates /debug — stop it to get one." : "No journal yet.", T.dim);
    return b.lines;
  }
  const who = new Map(driversOf(dbg).map((x) => [x.key, x.label]));
  const whoOf = (c: string | undefined) => (c ? (who.get(c) ?? c) : "");
  for (const c of [...dbg.inFlight].sort((a, b2) => a.startedAt - b2.startedAt)) {
    b.segs(["▶ ", T.yellow], [fmtDur(now - c.startedAt).padStart(7), T.yellow], ["  ", T.dim], [c.summary, T.yellow], [`  ${c.tab !== undefined ? `tab ${c.tab} · ` : ""}${whoOf(c.client)}`, T.dim]);
  }
  if (dbg.inFlight.length) b.blank();
  if (dbg.recent.length === 0) b.add("No commands yet.", T.dim);
  for (const c of [...dbg.recent].reverse()) {
    const tail = `  ${c.tab !== undefined ? `tab ${c.tab} · ` : ""}${whoOf(c.client)}`;
    b.segs(
      [clock(c.startedAt + c.ms), T.dim],
      [fmtDur(c.ms).padStart(8), c.ms >= 5000 ? T.yellow : T.dim],
      [c.ok ? " ✓ " : " ✗ ", c.ok ? T.green : T.red],
      [c.summary, c.ok ? T.fg : T.red],
      [c.ok ? tail : `  ${c.error ?? ""}`, c.ok ? T.dim : T.red],
    );
  }
  return b.lines;
}

const KIND_LABEL: Record<ChromeKind, string> = {
  node: "bx daemon (node)",
  browser: "chrome browser",
  renderer: "renderer",
  extension: "extension",
  gpu: "gpu",
  network: "network service",
  storage: "storage service",
  audio: "audio service",
  utility: "utility",
  crashpad: "crashpad",
  other: "",
};

function treeLines(tree: TreeProc[], width: number): Line[] {
  const b = lineBuilder();
  if (tree.length === 0) {
    b.add("No processes.", T.dim);
    return b.lines;
  }
  const statsW = 7 + 7 + 8 + 6;
  const nameW = Math.max(10, width - statsW);
  b.segs([pad("process", nameW), T.dim], ["pid".padStart(7), T.dim], ["ws".padStart(7), T.dim], ["commit".padStart(8), T.dim], ["cpu".padStart(6), T.dim]);
  for (const t of tree) {
    const label = KIND_LABEL[t.kind] || prettyCommand(t.proc.cmdline, t.proc.cwd, t.proc.exe) || t.proc.exe;
    const indent = `${"  ".repeat(Math.min(t.depth, 5))}${t.depth ? "└ " : ""}`;
    b.segs(
      [pad(fit(`${indent}${label}`, nameW - 1), nameW), t.depth === 0 ? T.fg : t.kind === "renderer" ? T.fg : T.dim],
      [String(t.proc.pid).padStart(7), T.dim],
      [fmtBytes(t.proc.memory).padStart(7), memColor(t.proc.memory)],
      [fmtBytes(t.proc.commit).padStart(8), memColor(t.proc.commit)],
      [fmtCpu(t.cpu).padStart(6), cpuColor(t.cpu)],
    );
  }
  const ws = tree.reduce((n, t) => n + t.proc.memory, 0);
  const commit = tree.reduce((n, t) => n + t.proc.commit, 0);
  const cpu = tree.reduce((n, t) => n + t.cpu, 0);
  b.segs([pad(`${tree.length} processes`, nameW + 7), T.dim], [fmtBytes(ws).padStart(7), T.fg], [fmtBytes(commit).padStart(8), T.fg], [fmtCpu(cpu).padStart(6), cpuColor(cpu)]);
  return b.lines;
}

const LOG_LINE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]\s?(.*)$/;

function logLines(profile: string, width: number, room: number): Line[] {
  const b = lineBuilder();
  const raw = readLogTail(profile, Math.max(1, room - 1));
  b.add(logPath(profile), T.dim);
  if (raw.length === 0) b.add("(empty)", T.dim);
  for (const l of raw) {
    const m = LOG_LINE.exec(l);
    const text = m ? (m[2] ?? "") : l;
    const when = m?.[1] ? clock(Date.parse(m[1])) : "";
    const color = /failed|error/i.test(text) ? T.red : /shutting down|idle/i.test(text) ? T.orange : /^debug /.test(text) ? T.cyan : /listening/.test(text) ? T.green : T.dim;
    b.segs([when ? `${when} ` : "", T.dim], [fit(text, Math.max(4, width - 9)), color]);
  }
  return b.lines;
}

function orphanLines(o: Orphan, width: number): Line[] {
  const b = lineBuilder();
  b.add(o.profile, T.orange, true);
  const why =
    o.kind === "daemon"
      ? "A bx daemon whose run file is gone, so no bx command can reach it, and it never shuts down. Its Chrome is underneath."
      : o.kind === "chrome"
        ? "A Chrome on a bx profile whose daemon is gone. Nothing will close it, and it holds the profile's lock, so bx can't launch on that profile."
        : "A run file whose daemon process is gone. bx clears these itself on the next command for that profile; clearing it here just tidies the list.";
  for (const l of wrap(why, width)) b.add(l, T.dim);
  b.blank();
  if (o.runPath) b.add(o.runPath, T.dim);
  if (o.tree.length) b.lines.push(...treeLines(o.tree, width));
  return b.lines;
}

// ─── formatting ───────────────────────────────────────────────────────────────

type Scale = "tree" | "page";

export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0";
  const mb = b / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 2)}G`;
  if (mb >= 100) return `${Math.round(mb)}M`;
  if (mb >= 1) return `${mb.toFixed(1)}M`;
  return `${Math.max(1, Math.round(b / 1024))}K`;
}

function fmtSigned(b: number): string {
  return `${b >= 0 ? "+" : "−"}${fmtBytes(Math.abs(b))}`;
}

/** Bytes per minute; "flat" under 64K/min, blank until there's a minute of history. */
function fmtRate(perMin: number | null): string {
  if (perMin === null) return "";
  if (Math.abs(perMin) < 64 * 1024) return "flat";
  return `${fmtSigned(perMin)}/m`;
}

function growthColor(perMin: number | null, scale: Scale): string {
  if (perMin === null || perMin <= 0) return T.dim;
  const [warn, bad] = scale === "tree" ? [1024 ** 2, 10 * 1024 ** 2] : [256 * 1024, 2 * 1024 ** 2];
  if (perMin >= bad) return T.red;
  if (perMin >= warn) return T.yellow;
  return T.dim;
}

function memColor(bytes: number): string {
  if (bytes >= 1024 ** 3) return T.red;
  if (bytes >= 600 * 1024 ** 2) return T.yellow;
  return T.fg;
}

function fmtCpu(cores: number): string {
  const pct = Math.round(cores * 100);
  if (pct <= 0) return cores > 0 ? "<1%" : "0%";
  return `${pct}%`;
}

function cpuColor(cores: number): string {
  if (cores >= 0.9) return T.red;
  if (cores >= 0.3) return T.yellow;
  if (cores >= 0.05) return T.fg;
  return T.dim;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtAgo(epochMs: number, now: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "";
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

function clock(epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 8);
}
