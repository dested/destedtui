import { useEffect, useReducer, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ActionBar, btn, seg, type BarItem } from "../components/ActionBar.tsx";
import { Footer } from "../components/Footer.tsx";
import { pad } from "../lib/text.ts";
import { BxSampler } from "../lib/bx.ts";
import { DEFAULT_PROFILE, profileCache, ProfileMsgSchema, profileDir, type ProfileInfo, type ProfileReq } from "../lib/bxProfiles.ts";
import { fmtAgo, fmtBytes, fmtCount, LineView, RowButton, type Seg } from "./Bx.tsx";

// bx profiles: every Chrome user-data-dir under ~/.bx/profiles, how big it is
// and when bx last used it, with a per-row delete and a bulk prune of the ones
// nobody has touched in a while. Sizing and deleting run in
// lib/bxProfilesWorker.ts; in-use comes from the same daemon scan as the bx screen.

const ACCENT = T.teal;
const ARM_MS = 3000;
const FLASH_MS = 8000;
const IN_USE_MS = 3000;
const RENDER_MS = 100;
const BTN_W = 11;
const SIZE_W = 8;
const AGE_W = 11;
const DETAIL_H = 4;

type Sort = "size" | "age" | "name";
const SORTS: readonly Sort[] = ["size", "age", "name"];
type Age = "1d" | "7d" | "30d";
const AGES: readonly Age[] = ["1d", "7d", "30d"];
const AGE_MS: Record<Age, number> = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

type ArmTarget = { kind: "row"; name: string } | { kind: "prune" };

interface Flash {
  text: string;
  color: string;
  until: number;
}

interface Deleting {
  total: number;
  done: number;
  freed: number;
  failed: { name: string; error: string }[];
}

const cache = profileCache;
const known = cache.known;

function sizeColor(b: number): string {
  if (b >= 1024 ** 3) return T.red;
  if (b >= 500 * 1024 ** 2) return T.yellow;
  if (b >= 100 * 1024 ** 2) return T.fg;
  return T.dim;
}

export function BxProfiles({ back }: { back: () => void }) {
  const { width, height } = useTerminalDimensions();
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [sort, setSort] = useState<Sort>("size");
  const [age, setAge] = useState<Age>("7d");
  const [selected, setSelected] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  const [armed, setArmed] = useState<{ target: ArmTarget; until: number } | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [sizing, setSizing] = useState<{ done: number; total: number } | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [inUse, setInUse] = useState<Map<string, string>>(new Map());
  const [frame, setFrame] = useState(0);
  const worker = useRef<Worker | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const del = useRef<Deleting | null>(null);
  const lastIndex = useRef(0);

  const say = (text: string, color: string) => setFlash({ text, color, until: Date.now() + FLASH_MS });
  /** Worker results arrive hundreds a second; repaint at most every RENDER_MS. */
  const soon = () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      render();
    }, RENDER_MS);
  };
  const post = (req: ProfileReq) => worker.current?.postMessage(req);

  const fullScan = () => {
    setSizing({ done: 0, total: cache.listed?.length ?? 0 });
    post({ type: "scan" });
  };

  useEffect(() => {
    const w = new Worker(new URL("../lib/bxProfilesWorker.ts", import.meta.url).href);
    worker.current = w;
    let done = 0;
    w.onmessage = (e: MessageEvent<unknown>) => {
      const parsed = ProfileMsgSchema.safeParse(e.data);
      if (!parsed.success) return;
      const m = parsed.data;
      switch (m.type) {
        case "listed": {
          cache.listed = m.names;
          const keep = new Set(m.names);
          for (const name of known.keys()) if (!keep.has(name)) known.delete(name);
          done = 0;
          setSizing({ done: 0, total: m.names.length });
          return soon();
        }
        case "sized": {
          known.set(m.info.name, m.info);
          const n = ++done;
          setSizing((s) => (s ? { ...s, done: n } : s));
          return soon();
        }
        case "gone":
          known.delete(m.name);
          if (cache.listed) cache.listed = cache.listed.filter((n) => n !== m.name);
          return soon();
        case "scanned":
          if (m.full) cache.measured = true;
          setSizing(null);
          return soon();
        case "deleted": {
          const d = del.current;
          if (!d) return;
          d.done++;
          if (m.error === null) {
            d.freed += known.get(m.name)?.bytes ?? 0;
            known.delete(m.name);
            if (cache.listed) cache.listed = cache.listed.filter((n) => n !== m.name);
          } else d.failed.push({ name: m.name, error: m.error });
          setDeleting({ ...d });
          return soon();
        }
        case "deleteDone": {
          const d = del.current;
          del.current = null;
          setDeleting(null);
          if (!d) return;
          const ok = d.done - d.failed.length;
          const first = d.failed[0];
          if (first) {
            say(`✓ deleted ${ok}, freed ${fmtBytes(d.freed)} · ✗ ${d.failed.length} failed — ${first.name}: ${first.error}`, T.yellow);
            post({ type: "scan", names: d.failed.map((f) => f.name) });
          } else say(`✓ deleted ${ok} profile${ok === 1 ? "" : "s"}, freed ${fmtBytes(d.freed)}`, T.green);
          return soon();
        }
        case "error":
          say(`✗ ${m.message}`, T.red);
          setSizing(null);
          return;
      }
    };
    w.onerror = (e) => {
      say(`✗ profile worker: ${e.message}`, T.red);
      setSizing(null);
    };
    fullScan();
    return () => {
      w.terminate();
      worker.current = null;
      if (pending.current) clearTimeout(pending.current);
    };
  }, []);

  // In use = a live daemon, an orphaned Chrome on that folder, or a run file.
  useEffect(() => {
    const sampler = new BxSampler();
    let alive = true;
    const look = () =>
      void sampler.scan().then((s) => {
        if (!alive) return;
        const m = new Map<string, string>();
        for (const d of s.daemons) m.set(d.profile, d.node ? "daemon running" : "run file, daemon not answering");
        for (const o of s.orphans) {
          if (o.kind === "chrome") m.set(o.profile, "Chrome still open (orphan)");
          else if (o.kind === "daemon") m.set(o.profile, "orphan daemon running");
          else m.set(o.profile, "stale run file: clear it on the bx screen");
        }
        setInUse(m);
      });
    look();
    const t = setInterval(look, IN_USE_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const busy = sizing !== null || deleting !== null;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [busy]);

  const now = Date.now();
  if (armed && armed.until < now) setArmed(null);
  if (flash && flash.until < now) setFlash(null);

  // --- rows -------------------------------------------------------------------
  const names = cache.listed ?? [];
  const rows = names.map((name) => ({ name, info: known.get(name) ?? null }));
  rows.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "age") return (a.info?.lastUsed ?? Infinity) - (b.info?.lastUsed ?? Infinity) || a.name.localeCompare(b.name);
    return (b.info?.bytes ?? -1) - (a.info?.bytes ?? -1) || a.name.localeCompare(b.name);
  });
  const cutoff = now - AGE_MS[age];
  const prunable = (r: { name: string; info: ProfileInfo | null }): r is { name: string; info: ProfileInfo } =>
    r.info !== null && r.name !== DEFAULT_PROFILE && !inUse.has(r.name) && r.info.lastUsed < cutoff;
  const candidates = rows.filter(prunable);
  const candidateBytes = candidates.reduce((n, r) => n + r.info.bytes, 0);
  let totalBytes = 0;
  for (const r of rows) totalBytes += r.info?.bytes ?? 0;

  // --- geometry ----------------------------------------------------------------
  const panelW = width - 2;
  const inner = panelW - 4;
  // header 3 + border 2 + summary + column header + action bar + status + detail + footer 1
  const visRows = Math.max(3, height - 11 - DETAIL_H);
  const nameW = Math.min(28, Math.max(10, ...rows.map((r) => r.name.length + 2)));

  const count = rows.length;
  const found = selected === null ? -1 : rows.findIndex((r) => r.name === selected);
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, count - 1));
  lastIndex.current = index;
  const current = rows[index] ?? null;
  const maxTop = Math.max(0, count - visRows);
  const topRow = Math.min(Math.max(Math.min(top, maxTop), index - visRows + 1), index);
  const windowRows = rows.slice(topRow, topRow + visRows);

  useEffect(() => {
    if (topRow !== top) setTop(topRow);
  }, [topRow, top]);

  const select = (i: number) => {
    const r = rows[Math.min(Math.max(0, i), count - 1)];
    if (r) setSelected(r.name);
  };

  // --- actions -------------------------------------------------------------------
  const arm = (t: ArmTarget, fire: () => void) => {
    if (deleting) return;
    const same = armed !== null && armed.target.kind === t.kind && (t.kind === "prune" || (armed.target.kind === "row" && armed.target.name === t.name));
    if (!same) {
      setArmed({ target: t, until: Date.now() + ARM_MS });
      return;
    }
    setArmed(null);
    fire();
  };

  const startDelete = (list: string[]) => {
    const d: Deleting = { total: list.length, done: 0, freed: 0, failed: [] };
    del.current = d;
    setDeleting({ ...d });
    post({ type: "delete", names: list });
  };

  const deleteRow = (name: string) => {
    const why = inUse.get(name);
    if (why) return say(`${name} is in use: ${why}`, T.yellow);
    arm({ kind: "row", name }, () => startDelete([name]));
  };

  const prune = () => {
    if (!cache.measured) return say("still sizing: prune once every profile is measured", T.dim);
    if (candidates.length === 0) return say(`nothing unused for ${age}+ (default and in-use profiles are always kept)`, T.dim);
    arm({ kind: "prune" }, () => startDelete(candidates.map((r) => r.name)));
  };

  const rescan = () => {
    if (sizing) return say("already sizing", T.dim);
    fullScan();
  };

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (key.name === "escape") return armed ? setArmed(null) : back();
    if (key.name === "up") return select(index - 1);
    if (key.name === "down") return select(index + 1);
    if (key.name === "pageup") return select(index - visRows);
    if (key.name === "pagedown") return select(index + visRows);
    if (key.name === "home") return select(0);
    if (key.name === "end") return select(count - 1);
    if (key.name === "x" && key.shift) return prune();
    switch (key.sequence) {
      case "x":
        return current ? deleteRow(current.name) : undefined;
      case "s":
        return setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length] ?? "size");
      case "a":
        return setAge((a) => AGES[(AGES.indexOf(a) + 1) % AGES.length] ?? "7d");
      case "r":
        return rescan();
    }
  });

  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
  const pruneArmed = armed?.target.kind === "prune";
  const actions: BarItem[] = [
    seg("sort", SORTS, sort, setSort),
    seg("unused ≥", AGES, age, setAge),
    btn(
      pruneArmed ? `✕? prune ${candidates.length} · ${fmtBytes(candidateBytes)}` : cache.measured ? `✕ prune ${candidates.length} · ${fmtBytes(candidateBytes)}` : "✕ prune (sizing…)",
      cache.measured ? T.red : T.dim,
      prune,
    ),
  ];
  const trailing: BarItem[] = [btn("↻ rescan", T.cyan, rescan), armed ? btn("✕ cancel", T.dim, () => setArmed(null)) : btn("← back", T.dim, back)];
  const rowArmed = (name: string) => (armed?.target.kind === "row" && armed.target.name === name) || (pruneArmed && candidates.some((c) => c.name === name));

  // --- summary + status --------------------------------------------------------------
  const summary: Seg[] = [
    [`${fmtCount(count)} profiles · `, T.dim],
    [fmtBytes(totalBytes), T.fg, true],
  ];
  if (sizing) summary.push([`  ${spin} sizing ${sizing.done}/${sizing.total || "…"}`, T.yellow]);
  if (inUse.size) summary.push([`  · ${inUse.size} in use`, ACCENT]);
  if (cache.measured) summary.push([`  · ${candidates.length} unused ≥${age} = ${fmtBytes(candidateBytes)}`, candidates.length ? T.orange : T.dim]);

  let status: Seg;
  if (deleting) status = [`${spin} deleting ${deleting.done}/${deleting.total} · ${fmtBytes(deleting.freed)} freed`, T.yellow];
  else if (armed) {
    const t = armed.target;
    status =
      t.kind === "prune"
        ? [`⚠ delete ${candidates.length} profiles unused for ${age}+ (${fmtBytes(candidateBytes)}): their cookies, logins and caches go. default and in-use are kept — press again`, T.red]
        : [`⚠ delete ${t.name} (${fmtBytes(known.get(t.name)?.bytes ?? 0)}) and its log: cookies, logins, cache — press again`, T.red];
  } else if (flash) status = [flash.text, flash.color];
  else status = [`${count > visRows ? `${topRow + 1}–${Math.min(count, topRow + visRows)} of ${count} · ` : ""}last used = Chrome's own state files or the bx log · default is never bulk-pruned`, T.dim];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" bx profiles "
        style={{
          width: panelW,
          flexGrow: 1,
          flexDirection: "column",
          border: true,
          borderStyle: "rounded",
          borderColor: armed ? T.red : T.border,
          titleColor: ACCENT,
          margin: 1,
          marginTop: 0,
          padding: 1,
          paddingTop: 0,
          paddingBottom: 0,
          backgroundColor: T.panel,
        }}
      >
        <LineView width={inner} line={{ segs: summary }} />
        <LineView
          width={inner}
          line={{
            segs: [
              [`    ${pad("profile", nameW)}`, T.dim],
              ["size".padStart(SIZE_W), T.dim],
              ["  ", T.dim],
              [pad("last used", AGE_W), T.dim],
              ["status", T.dim],
            ],
          }}
        />
        <box
          style={{ flexDirection: "column", height: visRows, width: inner, flexShrink: 0, backgroundColor: T.panel }}
          onMouseScroll={(e) => {
            if (e.scroll) select(index + (e.scroll.direction === "up" ? -1 : 1));
          }}
        >
          {count === 0 ? (
            <text fg={T.dim}>{pad(sizing ? "listing ~/.bx/profiles…" : "no bx profiles: ~/.bx/profiles is empty", inner)}</text>
          ) : (
            windowRows.map((r) => (
              <ProfileRow
                key={r.name}
                name={r.name}
                info={r.info}
                width={inner}
                nameW={nameW}
                now={now}
                selected={r === current}
                armed={rowArmed(r.name)}
                stale={prunable(r)}
                inUse={inUse.get(r.name) ?? null}
                onHover={() => setSelected(r.name)}
                onDelete={() => {
                  setSelected(r.name);
                  deleteRow(r.name);
                }}
              />
            ))
          )}
        </box>
        <ProfileDetail row={current} width={inner} now={now} inUse={current ? (inUse.get(current.name) ?? null) : null} />
        <ActionBar width={inner} items={actions} trailing={trailing} />
        <LineView width={inner} line={{ segs: [status] }} />
      </box>
      <Footer
        hints={[
          ["click", "anything"],
          ["↑↓", "select"],
          ["x", armed ? "again to confirm" : "delete"],
          ["esc", armed ? "disarm" : "back"],
        ]}
      />
    </box>
  );
}

function ProfileRow({
  name,
  info,
  width,
  nameW,
  now,
  selected,
  armed,
  stale,
  inUse,
  onHover,
  onDelete,
}: {
  name: string;
  info: ProfileInfo | null;
  width: number;
  nameW: number;
  now: number;
  selected: boolean;
  armed: boolean;
  stale: boolean;
  inUse: string | null;
  onHover: () => void;
  onDelete: () => void;
}) {
  const bg = armed ? T.surface : selected ? T.selectionBg : T.panel;
  const glyph: Seg = inUse ? ["● ", ACCENT] : ["○ ", T.dim];
  const size: Seg = info ? [fmtBytes(info.bytes).padStart(SIZE_W), sizeColor(info.bytes)] : ["…".padStart(SIZE_W), T.dim];
  const used = info ? (info.lastUsed ? `${fmtAgo(info.lastUsed, now)} ago` : "never") : "";
  const note = inUse ?? (name === DEFAULT_PROFILE ? "bx's default: kept by prune" : "");
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={onHover}>
      <LineView
        width={width - BTN_W}
        line={{
          segs: [
            [selected ? "❯ " : "  ", selected ? ACCENT : T.dim],
            glyph,
            [pad(name, nameW), armed ? T.red : T.fg, true],
            size,
            ["  ", T.dim],
            [pad(used, AGE_W), stale ? T.orange : T.dim],
            [note, inUse ? ACCENT : T.dim],
          ],
        }}
      />
      {inUse ? (
        <text fg={T.dim}>{pad(" in use", BTN_W)}</text>
      ) : (
        <box style={{ flexDirection: "row", width: BTN_W, height: 1 }}>
          <text>{" "}</text>
          <RowButton label={armed ? "✕? delete" : "✕ delete"} width={BTN_W - 1} hot={armed} onPress={onDelete} />
        </box>
      )}
    </box>
  );
}

function ProfileDetail({ row, width, now, inUse }: { row: { name: string; info: ProfileInfo | null } | null; width: number; now: number; inUse: string | null }) {
  const lines: Seg[][] = [];
  if (!row) lines.push([["", T.dim]]);
  else {
    const info = row.info;
    lines.push([
      [profileDir(row.name) ?? row.name, T.dim],
      [info ? `  · ${fmtCount(info.files)} files` : "  · sizing…", T.dim],
    ]);
    lines.push([
      ["biggest  ", T.dim],
      [info ? info.top.map((t) => `${t.name} ${fmtBytes(t.bytes)}`).join(" · ") || "empty" : "…", T.fg],
    ]);
    lines.push([
      ["last used ", T.dim],
      [info?.lastUsed ? `${fmtAgo(info.lastUsed, now)} ago (${new Date(info.lastUsed).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })})` : "never", T.fg],
      [info ? `  · bx log ${fmtBytes(info.logBytes)}` : "", T.dim],
    ]);
    lines.push(
      inUse
        ? [[`● in use: ${inUse}. Stop it on the bx screen before deleting`, ACCENT]]
        : [[`delete removes the folder and its bx log: cookies, logins, cache. The next \`bx --profile ${row.name}\` starts fresh`, T.dim]],
    );
  }
  while (lines.length < DETAIL_H) lines.push([["", T.dim]]);
  return (
    <box style={{ flexDirection: "column", height: DETAIL_H, width, flexShrink: 0, backgroundColor: T.surface }}>
      {lines.map((segs, i) => (
        <LineView key={i} width={width} line={{ segs }} />
      ))}
    </box>
  );
}
