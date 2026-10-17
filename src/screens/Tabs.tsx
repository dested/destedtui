import { useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { T } from "../theme.ts";
import { ActionBar, btn, type BarItem } from "../components/ActionBar.tsx";
import { Footer } from "../components/Footer.tsx";
import { pad } from "../lib/text.ts";
import { listSnapshots, readSnapshot, type SavedTab, type Snapshot, type SnapshotEntry } from "../lib/tabs/store.ts";
import { openCount, restoreRows, runWt, wtArgs, type Choice, type RestoreRow } from "../lib/tabs/restore.ts";
import { kindCounts, savedLabel } from "../lib/tabs/format.ts";
import { LineView, type Seg } from "./Bx.tsx";

// tabs: pick a saved Windows Terminal window (`tabs save <name>`), tick which
// of its tabs come back, and reopen them in this window with one wt call.
// features/tabs.md.

const ACCENT = T.cyan;
// header 3 + panel border 2 + footer 1 + bottom margin 1
const CHROME = 7;

export function Tabs({ snapshot, back, exit }: { snapshot?: string; back: () => void; exit: (message: string) => void }) {
  // `tabs restore <name>` opens straight on that snapshot; esc still lands on the list.
  const [initial] = useState(() => (snapshot ? readSnapshot(snapshot) : null));
  const [open, setOpen] = useState<Snapshot | null>(() => (initial?.ok ? initial.snap : null));
  const openError = initial && !initial.ok ? initial.error : null;
  if (open) return <TabList key={open.name} snap={open} back={() => setOpen(null)} exit={exit} />;
  return <SnapshotList first={openError} pick={setOpen} back={back} />;
}

// ─── snapshot list ────────────────────────────────────────────────────────────

function SnapshotList({ first, pick, back }: { first: string | null; pick: (s: Snapshot) => void; back: () => void }) {
  const { width, height } = useTerminalDimensions();
  const [entries] = useState<SnapshotEntry[]>(() => listSnapshots());
  const [index, setIndex] = useState(0);
  const [flash, setFlash] = useState<Seg | null>(first ? [`✗ ${first}`, T.red] : null);
  const now = Date.now();

  const panelW = width - 2;
  const inner = panelW - 4;
  const visRows = Math.max(3, height - CHROME - 4);
  const count = entries.length;
  const cur = Math.min(index, Math.max(0, count - 1));
  const top = Math.max(0, Math.min(cur - Math.floor(visRows / 2), count - visRows));
  const shown = entries.slice(top, top + visRows);
  const nameW = Math.min(32, Math.max(8, ...entries.map((e) => e.name.length + 2)));
  const whenW = 26;

  const choose = (i: number) => {
    const e = entries[i];
    if (!e) return;
    if (e.snap) pick(e.snap);
    else setFlash([`✗ ${e.error ?? "unreadable"}`, T.red]);
  };

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (key.name === "escape") return back();
    if (key.name === "up") return setIndex((i) => Math.max(0, Math.min(i, count - 1) - 1));
    if (key.name === "down") return setIndex((i) => Math.min(count - 1, i + 1));
    if (key.name === "return") return choose(cur);
  });

  const status: Seg = flash ?? (count ? ["click a snapshot to pick its tabs · tabs save <name> makes one", T.dim] : ["", T.dim]);
  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <Panel width={panelW}>
        <LineView width={inner} line={{ segs: [[`${count} saved window${count === 1 ? "" : "s"}`, T.fg, true], ["  · newest first", T.dim]] }} />
        <LineView width={inner} line={{ segs: [[`    ${pad("name", nameW)}`, T.dim], [pad("saved", whenW), T.dim], ["tabs", T.dim]] }} />
        <box style={{ flexDirection: "column", height: visRows, width: inner, flexShrink: 0 }}>
          {count === 0 ? (
            <LineView width={inner} line={{ segs: [["no snapshots yet — run tabs save <name> in the window you want back", T.dim]] }} />
          ) : (
            shown.map((e, k) => {
              const i = top + k;
              const sel = i === cur;
              const segs: Seg[] = [
                [sel ? "❯ " : "  ", ACCENT],
                [e.snap ? "◈ " : "⚠ ", e.snap ? ACCENT : T.red],
                [pad(e.name, nameW), e.snap ? T.fg : T.red, true],
              ];
              if (e.snap) segs.push([pad(savedLabel(e.snap.savedAt, now), whenW), T.dim], [`${e.snap.tabs.length} tabs`, T.fg], [`  ${kindCounts(e.snap.tabs)}`, T.dim]);
              else segs.push([e.error ?? "unreadable", T.red]);
              return (
                <box
                  key={e.name}
                  style={{ height: 1, width: inner, backgroundColor: sel ? T.selectionBg : T.panel }}
                  onMouseOver={() => setIndex(i)}
                  onMouseDown={() => choose(i)}
                >
                  <LineView width={inner} line={{ segs }} />
                </box>
              );
            })
          )}
        </box>
        <ActionBar width={inner} items={[btn("▶ open", T.green, () => choose(cur))]} trailing={[btn("← back", T.dim, back)]} />
        <LineView width={inner} line={{ segs: [status] }} />
      </Panel>
      <Footer
        hints={[
          ["click", "open"],
          ["↑↓", "select"],
          ["enter", "open"],
          ["esc", "back"],
        ]}
      />
    </box>
  );
}

// ─── one snapshot's tabs ────────────────────────────────────────────────────────

function TabList({ snap, back, exit }: { snap: Snapshot; back: () => void; exit: (message: string) => void }) {
  const { width, height } = useTerminalDimensions();
  const [rows] = useState<RestoreRow[]>(() => restoreRows(snap.tabs));
  const [on, setOn] = useState<boolean[]>(() => rows.map((r) => r.defaultOn));
  const [index, setIndex] = useState(0);
  const [flash, setFlash] = useState<Seg | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  const choices: Choice[] = rows.map((r, i) => ({ tab: r.tab, on: on[i] ?? false }));
  const opens = openCount(choices);
  const relaunch = choices.filter((c) => c.tab.kind === "app" && c.on).length;
  const apps = rows.map((r, i) => (r.tab.kind === "app" ? i : -1)).filter((i) => i >= 0);
  const appsOn = apps.length > 0 && apps.every((i) => on[i]);
  const missing = rows.filter((r) => r.transcriptMissing).length;

  const panelW = width - 2;
  const inner = panelW - 4;
  // summary + action bar + status, two lines per tab
  const visItems = Math.max(2, Math.floor((height - CHROME - 3) / 2));
  const count = rows.length;
  const cur = Math.min(index, Math.max(0, count - 1));
  const top = Math.max(0, Math.min(cur - Math.floor(visItems / 2), count - visItems));
  const shown = rows.slice(top, top + visItems);
  const titleW = Math.min(28, Math.max(10, ...rows.map((r) => r.tab.title.length + 2)));

  const toggle = (i: number) => setOn((v) => v.map((x, k) => (k === i ? !x : x)));
  const toggleApps = () => setOn((v) => v.map((x, k) => (rows[k]?.tab.kind === "app" ? !appsOn : x)));

  const restore = () => {
    if (busy) return;
    if (opens === 0) return setFlash(["nothing ticked: tick a tab first (space or click)", T.yellow]);
    setBusy(true);
    void runWt(wtArgs(choices)).then((r) => {
      setBusy(false);
      if (r.ok) exit(`✓ restored ${opens} tab${opens === 1 ? "" : "s"} from ${snap.name}${relaunch ? ` (${relaunch} app${relaunch === 1 ? "" : "s"} relaunched)` : ""}`);
      else setFlash([`✗ ${r.error ?? "wt failed"}`, T.red]);
    });
  };

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (key.name === "escape") return back();
    if (key.name === "up") return setIndex((i) => Math.max(0, Math.min(i, count - 1) - 1));
    if (key.name === "down") return setIndex((i) => Math.min(count - 1, i + 1));
    if (key.name === "space" || key.sequence === " ") return toggle(cur);
    if (key.name === "return") return restore();
    if (key.sequence === "a") return toggleApps();
  });

  const summary: Seg[] = [
    [snap.name, ACCENT, true],
    [`  saved ${savedLabel(snap.savedAt, now)}`, T.dim],
    [`  · ${count} tabs: ${kindCounts(snap.tabs)}`, T.dim],
    [`  · ${opens} to open`, opens ? T.green : T.dim],
  ];
  if (missing) summary.push([`  · ${missing} transcript${missing === 1 ? "" : "s"} missing`, T.orange]);

  const status: Seg = busy
    ? ["opening tabs in this window…", T.yellow]
    : (flash ?? [`unticked apps still open as a shell in their folder · unticked claude/shell tabs stay closed${count > visItems ? ` · ${top + 1}–${Math.min(count, top + visItems)} of ${count}` : ""}`, T.dim]);

  const actions: BarItem[] = [
    btn(busy ? "… opening" : `▶ restore ${opens} tab${opens === 1 ? "" : "s"}`, opens ? T.green : T.dim, restore),
    btn(apps.length ? `${appsOn ? "■" : "□"} relaunch apps (${apps.length})` : "no apps", apps.length ? T.orange : T.dim, toggleApps),
  ];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <Panel width={panelW}>
        <LineView width={inner} line={{ segs: summary }} />
        <box style={{ flexDirection: "column", height: visItems * 2, width: inner, flexShrink: 0 }}>
          {shown.map((r, k) => {
            const i = top + k;
            return (
              <TabRow
                key={`${r.tab.index}`}
                row={r}
                on={on[i] ?? false}
                selected={i === cur}
                width={inner}
                titleW={titleW}
                onHover={() => setIndex(i)}
                onToggle={() => {
                  setIndex(i);
                  toggle(i);
                }}
              />
            );
          })}
        </box>
        <ActionBar width={inner} items={actions} trailing={[btn("← back", T.dim, back)]} />
        <LineView width={inner} line={{ segs: [status] }} />
      </Panel>
      <Footer
        hints={[
          ["click", "tick"],
          ["↑↓", "select"],
          ["space", "tick"],
          ["a", "apps"],
          ["enter", "restore"],
          ["esc", "back"],
        ]}
      />
    </box>
  );
}

const KIND_COLOR: Record<SavedTab["kind"], string> = { claude: T.purple, shell: T.fg, app: T.orange };

function TabRow({
  row,
  on,
  selected,
  width,
  titleW,
  onHover,
  onToggle,
}: {
  row: RestoreRow;
  on: boolean;
  selected: boolean;
  width: number;
  titleW: number;
  onHover: () => void;
  onToggle: () => void;
}) {
  const t = row.tab;
  const bg = selected ? T.selectionBg : T.panel;
  const box: Seg = on ? ["■ ", T.green] : ["□ ", T.dim];
  const badge: Seg = t.platform === "wsl" ? [" WSL ", T.cyan] : [" Win ", T.blue];
  const line1: Seg[] = [
    [selected ? "❯ " : "  ", ACCENT],
    box,
    [pad(t.title, titleW), on ? T.fg : T.dim, true],
    badge,
    [pad(` ${t.kind}`, 8), KIND_COLOR[t.kind]],
    [t.cwd, T.dim],
  ];
  let line2: Seg[];
  if (t.kind === "claude") {
    line2 = row.transcriptMissing
      ? [["      ⚠ transcript missing — --resume would fail", T.orange]]
      : [[`      ${t.lastPrompt ? `“${t.lastPrompt}”` : "no typed prompt in the transcript tail"}`, T.dim]];
  } else if (t.kind === "app") line2 = [[`      ${on ? "▶ relaunch " : "shell only, skips "}`, on ? T.orange : T.dim], [t.command, T.dim]];
  else line2 = [["      shell", T.dim]];
  return (
    <box style={{ flexDirection: "column", height: 2, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={onToggle}>
      <LineView width={width} line={{ segs: line1 }} />
      <LineView width={width} line={{ segs: line2 }} />
    </box>
  );
}

function Panel({ width, children }: { width: number; children: ReactNode }) {
  return (
    <box
      title=" tabs "
      style={{
        width,
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: T.border,
        titleColor: ACCENT,
        margin: 1,
        marginTop: 0,
        padding: 1,
        paddingTop: 0,
        paddingBottom: 0,
        backgroundColor: T.panel,
      }}
    >
      {children}
    </box>
  );
}
