import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ActionBar, btn, seg, type BarItem } from "../components/ActionBar.tsx";
import { Footer } from "../components/Footer.tsx";
import { fit, pad, wrap } from "../lib/text.ts";
import { openInChrome } from "../lib/run.ts";
import { urlFor } from "../lib/ports.ts";
import { prettyCommand } from "../lib/proctext.ts";
import { byLoad, killableUnits, killRoots, leftoverUnits, ProcSampler, type Group, type ProcScan, type Unit } from "../lib/procs.ts";

// What Claude has spun up: one group per Claude session (its tool shells,
// servers, watchers), orphan groups per project (their session is gone), and
// dev processes outside Claude. Busiest first. See lib/procs.ts.

const ACCENT = T.cyan;
const SCAN_MS = 2000;
const ARM_MS = 3000;
const FLASH_MS = 5000;
const DETAIL_MIN = 46;

type Show = "busy" | "all";
type Sort = "cpu" | "mem";
type Open = "closed" | "notable" | "all";

interface Props {
  choose: (dir: string) => void;
  back: () => void;
}

type Row =
  | { kind: "group"; id: string; g: Group; open: Open }
  | { kind: "unit"; id: string; g: Group; u: Unit }
  | { kind: "more"; id: string; g: Group; hidden: Unit[] };

type ArmTarget = { kind: "unit"; id: string } | { kind: "group"; id: string } | { kind: "orphans" };

interface Armed {
  target: ArmTarget;
  until: number;
}

interface Flash {
  text: string;
  color: string;
  until: number;
}

/** Worth a line of its own: busy, serving, big, or flagged. */
function notable(u: Unit): boolean {
  return u.load >= 0.02 || u.ports.length > 0 || u.memory >= 150 * 1024 ** 2 || u.flags.has("hot") || u.flags.has("dupe");
}

function sameTarget(a: ArmTarget, b: ArmTarget): boolean {
  if (a.kind === "orphans" || b.kind === "orphans") return a.kind === b.kind;
  return a.kind === b.kind && a.id === b.id;
}

export function Procs({ choose, back }: Props) {
  const sampler = useRef(new ProcSampler());
  // First scan during the first render (ui.md, Painting); its rates are all zero
  // until the follow-up scan a moment later.
  const [scan, setScan] = useState<ProcScan>(() => sampler.current.scan());
  const [show, setShow] = useState<Show>("busy");
  const [sort, setSort] = useState<Sort>("cpu");
  const [opens, setOpens] = useState<Map<string, Open>>(() => new Map());
  const [filter, setFilter] = useState("");
  const [typing, setTyping] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [killing, setKilling] = useState(false);
  const [frame, setFrame] = useState(0);
  const lastIndex = useRef(0);
  const { width, height } = useTerminalDimensions();

  const rescan = () => setScan(sampler.current.scan());

  useEffect(() => {
    const first = setTimeout(rescan, 600);
    const t = setInterval(rescan, SCAN_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  if (armed && armed.until < now) setArmed(null);
  if (flash && flash.until < now) setFlash(null);

  // --- rows -------------------------------------------------------------------
  const { rows, quietSessions } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groupHay = (g: Group) => `${g.title} ${g.project} ${g.session?.label ?? ""} ${g.session?.now ?? ""}`.toLowerCase();
    const unitHay = (u: Unit) => `${u.rep.cmdline} ${u.project} ${u.ports.map((p) => `:${p}`).join(" ")}`.toLowerCase();
    const byMem = (a: { memory: number; key: string }, b: { memory: number; key: string }) =>
      Math.floor(b.memory / 2 ** 26) - Math.floor(a.memory / 2 ** 26) || a.key.localeCompare(b.key);
    const byUnit = sort === "cpu" ? byLoad : byMem;
    const byGroup = sort === "cpu" ? byLoad : byMem;

    const out: Row[] = [];
    let quiet = 0;
    const groups = [...scan.groups].sort((a, b) => (a.kind === "outside" ? 1 : 0) - (b.kind === "outside" ? 1 : 0) || byGroup(a, b));
    for (const g of groups) {
      const groupHit = q !== "" && groupHay(g).includes(q);
      let units = [...g.units].sort(byUnit);
      if (q && !groupHit) units = units.filter((u) => unitHay(u).includes(q));
      if (q && !groupHit && units.length === 0) continue;
      if (show === "busy" && !q && g.units.length === 0) {
        quiet++;
        continue;
      }
      const shown = units.filter(notable);
      const fallback: Open = shown.length > 0 || q ? "notable" : "closed";
      const open = opens.get(g.key) ?? (show === "all" && fallback === "closed" ? "notable" : fallback);
      out.push({ kind: "group", id: g.key, g, open });
      if (open === "closed") continue;
      const list = open === "all" || show === "all" || q ? units : shown;
      for (const u of list) out.push({ kind: "unit", id: `${g.key}|${u.key}`, g, u });
      const hidden = units.filter((u) => !list.includes(u));
      if (hidden.length > 0) out.push({ kind: "more", id: `${g.key}|more`, g, hidden });
    }
    return { rows: out, quietSessions: quiet };
  }, [scan, filter, show, sort, opens]);

  // --- geometry ---------------------------------------------------------------
  const showDetail = width >= 120;
  const listWidth = showDetail ? Math.max(76, Math.min(width - DETAIL_MIN - 2, Math.floor(width * 0.62))) : width - 2;
  const detailWidth = width - listWidth - 3;
  const inner = listWidth - 4;
  // header 3 + border 2 + summary, filter, column header, action bar, status + margin 1 + footer 1
  const visRows = Math.max(3, height - 12);

  const count = rows.length;
  const found = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);
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
    if (r) setSelectedId(r.id);
  };

  const say = (text: string, color: string) => setFlash({ text, color, until: Date.now() + FLASH_MS });

  const setOpen = (key: string, open: Open) =>
    setOpens((m) => {
      const next = new Map(m);
      next.set(key, open);
      return next;
    });

  const toggle = (row: Row | null) => {
    if (!row) return;
    if (row.kind === "group") setOpen(row.g.key, row.open === "closed" ? "notable" : "closed");
    else if (row.kind === "more") setOpen(row.g.key, "all");
    else if (row.u.ports[0] !== undefined) {
      openInChrome(urlFor(row.u.ports[0]));
      say(`↗ opened ${urlFor(row.u.ports[0])}`, T.cyan);
    }
  };

  const orphanUnits = useMemo(() => leftoverUnits(scan.groups), [scan]);

  const unitsFor = (t: ArmTarget): Unit[] => {
    if (t.kind === "orphans") return orphanUnits;
    if (t.kind === "group") {
      const g = scan.groups.find((x) => x.key === t.id);
      return g ? killableUnits(g) : [];
    }
    const row = rows.find((r) => r.id === t.id);
    return row?.kind === "unit" ? [row.u] : [];
  };

  /** First press arms, the second within ARM_MS fires. */
  const kill = (t: ArmTarget | null) => {
    if (!t || killing) return;
    if (!armed || !sameTarget(armed.target, t)) {
      if (unitsFor(t).length === 0) return say("nothing to kill there", T.dim);
      setArmed({ target: t, until: Date.now() + ARM_MS });
      return;
    }
    setArmed(null);
    const units = unitsFor(t);
    const procs = units.reduce((n, u) => n + u.tree.length, 0);
    const what = t.kind === "unit" && units[0] ? unitName(units[0]) : `${units.length} unit${units.length === 1 ? "" : "s"}`;
    setKilling(true);
    void killRoots(units).then(() => {
      setKilling(false);
      say(`✓ killed ${what} — ${procs} process${procs === 1 ? "" : "es"}`, T.green);
      rescan();
    });
  };

  const targetOf = (row: Row | null): ArmTarget | null => {
    if (!row) return null;
    if (row.kind === "unit") return { kind: "unit", id: row.id };
    if (row.kind === "group") return { kind: "group", id: row.g.key };
    return null;
  };

  const cdThere = (row: Row | null) => {
    if (!row) return;
    const dir = row.kind === "unit" ? row.u.rep.cwd || row.u.root.cwd : (row.g.session?.cwd ?? row.g.units[0]?.rep.cwd ?? "");
    if (dir) choose(dir);
    else say("✗ no working directory to go to", T.red);
  };

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (typing) {
      if (key.name === "escape") {
        setFilter("");
        setTyping(false);
      } else if (key.name === "return") setTyping(false);
      else if (key.name === "backspace") setFilter((f) => f.slice(0, -1));
      else if (key.name === "up") select(index - 1);
      else if (key.name === "down") select(index + 1);
      else if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
        const ch = key.sequence;
        setFilter((f) => f + ch);
      }
      return;
    }
    if (key.name === "escape") {
      if (armed) return setArmed(null);
      if (filter) return setFilter("");
      return back();
    }
    if (key.name === "up") return select(index - 1);
    if (key.name === "down") return select(index + 1);
    if (key.name === "pageup") return select(index - visRows);
    if (key.name === "pagedown") return select(index + visRows);
    if (key.name === "home") return select(0);
    if (key.name === "end") return select(count - 1);
    if (key.name === "return" || key.name === "space") return toggle(current);
    if (key.name === "left" && current) {
      if (current.kind === "group") return setOpen(current.g.key, "closed");
      const g = rows.find((r) => r.kind === "group" && r.g.key === current.g.key);
      if (g) setSelectedId(g.id);
      return;
    }
    if (key.name === "right" && current?.kind === "group") return setOpen(current.g.key, "all");
    if (key.name === "x" && key.shift) return kill({ kind: "orphans" });
    switch (key.sequence) {
      case "x":
        return kill(targetOf(current));
      case "g":
        return cdThere(current);
      case "a":
        return setShow((s) => (s === "busy" ? "all" : "busy"));
      case "s":
        return setSort((s) => (s === "cpu" ? "mem" : "cpu"));
      case "r":
        rescan();
        return say("↻ rescanned", T.dim);
      case "/":
        return setTyping(true);
    }
  });

  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
  const orphansArmed = armed?.target.kind === "orphans";
  const actions: BarItem[] = [
    seg("show", ["busy", "all"], show, setShow),
    seg("sort", ["cpu", "mem"], sort, setSort),
    btn(orphansArmed ? `✕? kill ${orphanUnits.length} leftovers` : `✕ orphan leftovers (${orphanUnits.length})`, T.red, () => kill({ kind: "orphans" })),
  ];
  const trailing: BarItem[] = [
    btn("↻ rescan", T.cyan, () => {
      rescan();
      say("↻ rescanned", T.dim);
    }),
    orphansArmed ? btn("✕ cancel", T.dim, () => setArmed(null)) : btn("← back", T.dim, back),
  ];

  const armedId = armed && armed.target.kind !== "orphans" ? armed.target.id : null;
  const armedUnits = armed ? unitsFor(armed.target) : [];
  const orphanKeys = orphansArmed ? new Set(orphanUnits.map((u) => u.key)) : null;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <box
          title=" claude procs "
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
          <Summary width={inner} scan={scan} />
          <FilterLine
            width={inner}
            filter={filter}
            typing={typing}
            frame={frame}
            onStart={() => setTyping(true)}
            onClear={() => {
              setFilter("");
              setTyping(false);
            }}
          />
          <text fg={T.dim}>{columnHeader(inner)}</text>
          <box
            style={{ flexDirection: "column", height: visRows, width: inner, flexShrink: 0, backgroundColor: T.panel }}
            onMouseScroll={(e) => {
              if (e.scroll) select(index + (e.scroll.direction === "up" ? -3 : 3));
            }}
          >
            {count === 0 ? (
              <text fg={T.dim}>{pad(scan.error ?? (filter ? `Nothing matches "${filter}" — esc clears it` : "Nothing running"), inner)}</text>
            ) : (
              windowRows.map((row) => {
                const selected = row === current;
                const hover = () => setSelectedId(row.id);
                if (row.kind === "group")
                  return (
                    <GroupRow
                      key={row.id}
                      row={row}
                      width={inner}
                      selected={selected}
                      armed={armedId === row.g.key}
                      onHover={hover}
                      onToggle={() => toggle(row)}
                      onKill={() => {
                        setSelectedId(row.id);
                        kill({ kind: "group", id: row.g.key });
                      }}
                    />
                  );
                if (row.kind === "more") return <MoreRow key={row.id} row={row} width={inner} selected={selected} onHover={hover} onOpen={() => toggle(row)} />;
                return (
                  <UnitRow
                    key={row.id}
                    row={row}
                    width={inner}
                    selected={selected}
                    armed={armedId === row.id || (armedId === row.g.key && killableUnits(row.g).includes(row.u)) || (orphanKeys?.has(row.u.key) ?? false)}
                    onHover={hover}
                    onOpen={() => toggle(row)}
                    onKill={() => {
                      setSelectedId(row.id);
                      kill({ kind: "unit", id: row.id });
                    }}
                  />
                );
              })
            )}
          </box>
          <ActionBar width={inner} items={actions} trailing={trailing} />
          <StatusLine
            width={inner}
            rows={rows}
            topRow={topRow}
            visRows={visRows}
            armed={armed}
            armedUnits={armedUnits}
            flash={flash}
            killing={killing}
            spin={spin}
            quietSessions={quietSessions}
          />
        </box>
        {showDetail && <Detail row={current} width={detailWidth} height={height - 6} onCd={() => cdThere(current)} />}
      </box>
      <Footer
        hints={
          typing
            ? [
                ["type", "filter"],
                ["↑↓", "select"],
                ["enter", "keep"],
                ["esc", "clear"],
              ]
            : [
                ["click", "anything"],
                ["↑↓", "select"],
                ["enter", "open/fold"],
                ["x", armed ? "again to kill" : "kill"],
                ["esc", armed ? "disarm" : filter ? "clear filter" : "back"],
              ]
        }
      />
    </box>
  );
}

// ─── columns ──────────────────────────────────────────────────────────────────

const PORT_W = 7; // ":64027 "
const TAG_W = 11;
const CPU_W = 6;
const MEM_W = 6;
const UP_W = 5;
const BTN_W = 7; // " " + [ ✕ all ]
const UNIT_INDENT = 4; // caret 2 + indent 2

function cmdWidth(width: number): number {
  return Math.max(12, width - UNIT_INDENT - PORT_W - TAG_W - CPU_W - MEM_W - UP_W - BTN_W);
}

function columnHeader(width: number): string {
  return pad(
    `${" ".repeat(UNIT_INDENT)}${pad("port", PORT_W)}${pad("what", cmdWidth(width))}${pad("", TAG_W)}${"cpu".padStart(CPU_W)}${"mem".padStart(MEM_W)}${"up".padStart(UP_W)}`,
    width,
  );
}

function Summary({ width, scan }: { width: number; scan: ProcScan }) {
  if (scan.error) return <text fg={T.red}>{pad(scan.error, width)}</text>;
  const pct = Math.round((scan.machineCpu / scan.cores) * 100);
  const machine = `machine ${pct}% (${scan.machineCpu.toFixed(1)} of ${scan.cores} cores)`;
  const ours = ` · these: ${scan.totalCpu.toFixed(1)} cores, ${fmtMem(scan.totalMemory)}, ${scan.procCount} procs`;
  const hot = scan.groups.flatMap((g) => g.units).filter((u) => u.flags.has("hot")).length;
  const hotText = hot ? ` · ${hot} hot` : "";
  return (
    <text>
      <span fg={pct >= 60 ? T.red : pct >= 30 ? T.yellow : T.green}>{machine}</span>
      <span fg={T.dim}>{ours}</span>
      <span fg={T.red}>{pad(hotText, Math.max(0, width - machine.length - ours.length))}</span>
    </text>
  );
}

function FilterLine({
  width,
  filter,
  typing,
  frame,
  onStart,
  onClear,
}: {
  width: number;
  filter: string;
  typing: boolean;
  frame: number;
  onStart: () => void;
  onClear: () => void;
}) {
  if (!filter && !typing) return <ActionBar width={width} items={[btn("⌕ filter", T.yellow, onStart)]} trailing={[]} />;
  const caret = typing && frame % 8 < 5 ? "▏" : " ";
  const textW = Math.max(4, width - 11);
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <box style={{ height: 1, width: textW }} onMouseDown={onStart}>
        <text>
          <span fg={typing ? T.yellow : T.fg}>{fit(`/ ${filter}`, textW - 1)}</span>
          <span fg={T.yellow}>{pad(caret, Math.max(1, textW - Math.min(filter.length + 2, textW - 1)))}</span>
        </text>
      </box>
      <ActionBar width={width - textW} items={[]} trailing={[btn("✕ clear", T.red, onClear)]} />
    </box>
  );
}

function groupGlyph(g: Group): { glyph: string; color: string } {
  if (g.kind === "orphans") return { glyph: "⚠", color: T.orange };
  if (g.kind === "outside") return { glyph: "○", color: T.dim };
  if (g.session?.status === "busy") return { glyph: "●", color: T.yellow };
  return { glyph: "●", color: T.dim };
}

function groupTitle(g: Group): { name: string; sub: string } {
  if (g.kind === "orphans") return { name: `${g.project} orphans`, sub: "session gone" };
  if (g.kind === "outside") return { name: "outside claude", sub: "your terminals, editors, services" };
  const s = g.session;
  const sub = [s?.label, s?.status].filter(Boolean).join(" · ");
  return { name: g.title, sub };
}

function GroupRow({
  row,
  width,
  selected,
  armed,
  onHover,
  onToggle,
  onKill,
}: {
  row: Extract<Row, { kind: "group" }>;
  width: number;
  selected: boolean;
  armed: boolean;
  onHover: () => void;
  onToggle: () => void;
  onKill: () => void;
}) {
  const { g } = row;
  const dot = groupGlyph(g);
  const { name, sub } = groupTitle(g);
  const fold = row.open === "closed" ? "▸" : "▾";
  const countText = `${g.units.length} unit${g.units.length === 1 ? "" : "s"}`;
  const textW = width - 2 - 2 - 2 - TAG_W - CPU_W - MEM_W - UP_W - BTN_W;
  const nameText = fit(name, Math.max(6, Math.min(name.length, textW - 2)));
  const subText = fit(sub ? `  ${sub}` : "", Math.max(0, textW - nameText.length));
  const gap = " ".repeat(Math.max(0, textW - nameText.length - subText.length));
  const bg = armed ? T.surface : selected ? T.selectionBg : T.surfaceAlt;
  const killable = killableUnits(g).length > 0;
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={onToggle}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={T.dim}>{`${fold} `}</span>
        <span fg={dot.color}>{`${dot.glyph} `}</span>
        <span fg={armed ? T.red : g.kind === "orphans" ? T.orange : T.fg}>
          <strong>{nameText}</strong>
        </span>
        <span fg={T.dim}>{subText}</span>
        <span>{gap}</span>
        <span fg={T.dim}>{fit(countText, TAG_W - 1).padStart(TAG_W)}</span>
        <span fg={cpuColor(g.load)}>{fmtCpu(g.load).padStart(CPU_W)}</span>
        <span fg={memColor(g.memory)}>{fmtMem(g.memory).padStart(MEM_W)}</span>
        <span fg={T.dim}>{(g.claude ? fmtUp(g.claude.startedAt) : "").padStart(UP_W)}</span>
        <span>{" "}</span>
      </text>
      {killable ? <RowButton label={armed ? "✕? all" : "✕ all"} width={BTN_W - 1} hot={armed} onPress={onKill} /> : <box style={{ width: BTN_W - 1, height: 1 }} />}
    </box>
  );
}

function unitName(u: Unit): string {
  return prettyCommand(u.rep.cmdline, u.rep.cwd, u.rep.exe) || u.rep.exe;
}

function tagsOf(u: Unit, g: Group): { text: string; color: string } {
  const tags: string[] = [];
  if (u.flags.has("hot")) tags.push("hot");
  if (u.copies > 1) tags.push(`×${u.copies}`);
  if (u.flags.has("mcp")) tags.push("mcp");
  if (u.flags.has("daemon")) tags.push("daemon");
  if (u.flags.has("detached")) tags.push("bg");
  if (u.flags.has("service")) tags.push("svc");
  if (u.flags.has("orphan") && g.kind !== "orphans") tags.push("orphan");
  if (u.flags.has("old")) tags.push("old");
  const color = u.flags.has("hot") ? T.red : u.copies > 1 ? T.yellow : u.flags.has("mcp") ? T.cyan : T.dim;
  return { text: tags.join(" "), color };
}

function UnitRow({
  row,
  width,
  selected,
  armed,
  onHover,
  onOpen,
  onKill,
}: {
  row: Extract<Row, { kind: "unit" }>;
  width: number;
  selected: boolean;
  armed: boolean;
  onHover: () => void;
  onOpen: () => void;
  onKill: () => void;
}) {
  const { u, g } = row;
  const cw = cmdWidth(width);
  const port = u.ports[0] !== undefined ? `:${u.ports[0]}${u.ports.length > 1 ? "+" : ""}` : "";
  const tags = tagsOf(u, g);
  const n = u.tree.length > 1 ? ` (${u.tree.length})` : "";
  const name = fit(unitName(u), Math.max(4, cw - n.length - 1));
  const bg = armed ? T.surface : selected ? T.selectionBg : T.panel;
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={onOpen}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span>{"  "}</span>
        <span fg={ACCENT}>{pad(port, PORT_W)}</span>
        <span fg={armed ? T.red : selected ? T.fg : u.load >= 0.3 ? T.fg : T.dim}>{name}</span>
        <span fg={T.dim}>{pad(n, cw - name.length)}</span>
        <span fg={tags.color}>{pad(fit(tags.text, TAG_W - 1), TAG_W)}</span>
        <span fg={cpuColor(u.load)}>{fmtCpu(u.load).padStart(CPU_W)}</span>
        <span fg={memColor(u.memory)}>{fmtMem(u.memory).padStart(MEM_W)}</span>
        <span fg={T.dim}>{fmtUp(u.root.startedAt).padStart(UP_W)}</span>
        <span>{" "}</span>
      </text>
      <RowButton label={armed ? "✕?" : "✕"} width={BTN_W - 1} hot={armed} onPress={onKill} />
    </box>
  );
}

function MoreRow({
  row,
  width,
  selected,
  onHover,
  onOpen,
}: {
  row: Extract<Row, { kind: "more" }>;
  width: number;
  selected: boolean;
  onHover: () => void;
  onOpen: () => void;
}) {
  const kinds = new Map<string, number>();
  for (const u of row.hidden) {
    const k = u.rep.exe.replace(/\.exe$/i, "");
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const summary = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(", ");
  const mem = row.hidden.reduce((n, u) => n + u.memory, 0);
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: selected ? T.selectionBg : T.panel }} onMouseOver={onHover} onMouseDown={onOpen}>
      <text fg={T.dim}>{pad(`${selected ? "❯ " : "  "}    + ${row.hidden.length} quiet: ${summary} · ${fmtMem(mem)}`, width)}</text>
    </box>
  );
}

function RowButton({ label, width, hot, onPress }: { label: string; width: number; hot: boolean; onPress: () => void }) {
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
  rows,
  topRow,
  visRows,
  armed,
  armedUnits,
  flash,
  killing,
  spin,
  quietSessions,
}: {
  width: number;
  rows: Row[];
  topRow: number;
  visRows: number;
  armed: Armed | null;
  armedUnits: Unit[];
  flash: Flash | null;
  killing: boolean;
  spin: string;
  quietSessions: number;
}) {
  if (killing) return <text fg={T.yellow}>{pad(`${spin} killing…`, width)}</text>;
  if (armed) {
    const procs = armedUnits.reduce((n, u) => n + u.tree.length, 0);
    const cpu = armedUnits.reduce((n, u) => n + u.load, 0);
    const mem = armedUnits.reduce((n, u) => n + u.memory, 0);
    const first = armedUnits[0];
    const what = armed.target.kind === "unit" && first ? unitName(first) : `${armedUnits.length} units`;
    const mcp = armed.target.kind === "unit" && first?.flags.has("mcp") ? " · it's an MCP server: that session loses its tools" : "";
    return <text fg={T.red}>{pad(`⚠ kill ${what}: ${procs} procs, ${fmtCpu(cpu)} cpu, ${fmtMem(mem)}${mcp} — press again`, width)}</text>;
  }
  if (flash) return <text fg={flash.color}>{pad(flash.text, width)}</text>;
  const range = rows.length > visRows ? `${topRow + 1}–${Math.min(rows.length, topRow + visRows)} of ${rows.length} · ` : "";
  const quiet = quietSessions ? `${quietSessions} idle session${quietSessions === 1 ? "" : "s"} hidden · ` : "";
  return <text fg={T.dim}>{pad(`${range}${quiet}cpu = % of one core · live, every ${SCAN_MS / 1000}s`, width)}</text>;
}

// ─── detail pane ──────────────────────────────────────────────────────────────

function Detail({ row, width, height, onCd }: { row: Row | null; width: number; height: number; onCd: () => void }) {
  const inner = width - 4;
  const panel = {
    width,
    flexShrink: 0,
    flexDirection: "column" as const,
    border: true,
    borderStyle: "rounded" as const,
    borderColor: T.border,
    titleColor: ACCENT,
    margin: 1,
    marginTop: 0,
    padding: 1,
    paddingTop: 0,
    backgroundColor: T.panel,
  };
  if (!row || row.kind === "more") {
    return (
      <box title=" details " style={panel}>
        <text fg={T.dim}>{pad(row ? "enter shows the quiet ones too" : "nothing selected", inner)}</text>
      </box>
    );
  }
  const lines: { text: string; color: string; bold?: boolean }[] = [];
  const add = (text: string, color: string = T.fg, bold = false) => lines.push({ text, color, bold });
  const blank = () => add("", T.dim);
  const g = row.g;

  if (row.kind === "group") {
    const { name } = groupTitle(g);
    add(name, T.fg, true);
    if (g.kind === "session" && g.session) {
      const s = g.session;
      if (s.label) add(s.label, ACCENT);
      for (const l of wrap(s.now ?? "", inner).slice(0, 3)) add(l, T.fg);
      add(`${s.status ?? "?"}${s.cardState ? ` · card: ${s.cardState}` : ""}`, s.status === "busy" ? T.yellow : T.dim);
      blank();
      add(`⌂ ${s.cwd}`, T.teal);
      if (g.claude) add(`claude pid ${g.claude.pid} · up ${fmtUp(g.claude.startedAt)} · itself ${fmtCpu(g.selfCpu)} ${fmtMem(g.claude.memory)}`, T.dim);
      if (s.sessionId) add(`session ${s.sessionId}`, T.dim);
    } else if (g.kind === "orphans") {
      add("Whatever started these has exited: its Claude session closed, or a", T.dim);
      add("nohup / background shell outlived it. Nothing is watching them.", T.dim);
      add("✕ all skips daemons (detached on purpose); kill those by row.", T.dim);
    } else {
      add("Dev processes no Claude session started: your terminals, editors,", T.dim);
      add("daemons. Listed so you can see them; kill with care.", T.dim);
    }
    blank();
    const killable = killableUnits(g);
    const skipped = g.units.length - killable.length;
    add(`${g.units.length} units · ${g.units.reduce((n, u) => n + u.tree.length, 0)} procs · ${fmtCpu(g.load)} cpu · ${fmtMem(g.memory)}`, T.fg);
    if (killable.length) add(`✕ all kills ${killable.length} unit${killable.length === 1 ? "" : "s"}${skipped ? ` (skips ${skipped} mcp/daemon/service)` : ""}${g.kind === "session" ? ", not claude itself" : ""}`, T.red);
    blank();
    for (const u of g.units.slice(0, Math.max(0, height - lines.length - 4))) {
      add(`${fmtCpu(u.load).padStart(5)} ${fmtMem(u.memory).padStart(5)}  ${unitName(u)}`, u.flags.has("hot") ? T.red : T.dim);
    }
  } else {
    const u = row.u;
    add(unitName(u), T.fg, true);
    add(
      g.kind === "session"
        ? `from ${g.title}${g.session?.label ? ` · ${g.session.label}` : ""}`
        : g.kind === "orphans"
          ? `orphan · ${g.project} · its session is gone`
          : "outside claude",
      g.kind === "orphans" ? T.orange : ACCENT,
    );
    blank();
    if (u.flags.has("hot")) add(`▲ steadily using ${fmtCpu(u.load)} of a core`, T.red);
    if (u.copies > 1) add(`× ${u.copies} copies of this exact command in this folder`, T.yellow);
    if (u.flags.has("detached")) add("↯ launched from this session's scratchpad, then detached", T.yellow);
    if (u.flags.has("orphan") && g.kind !== "orphans") add("⚠ whatever started it has exited", T.orange);
    if (u.flags.has("mcp")) add("mcp server: killing it breaks that session's tools", T.cyan);
    if (u.flags.has("service")) add("a Windows service", T.dim);
    if (u.flags.has("daemon")) add("a daemon: detached on purpose, may be in use — bulk kills skip it", T.cyan);
    if (u.flags.has("old")) add(`◷ running ${fmtUp(u.root.startedAt)}`, T.dim);
    for (const p of u.ports) add(`↗ ${urlFor(p)}`, T.cyan);
    blank();
    add(`⌂ ${u.rep.cwd || u.root.cwd || "(cwd unreadable)"}`, T.teal);
    for (const l of wrap(u.rep.cmdline || "(command line unreadable)", inner - 2).slice(0, 3)) add(`  ${l}`, T.dim);
    blank();
    add(`tree · ${u.tree.length} proc${u.tree.length === 1 ? "" : "s"} · ${fmtCpu(u.load)} · ${fmtMem(u.memory)}`, T.dim);
    const room = Math.max(1, height - lines.length - 3);
    for (const t of u.tree.slice(0, room)) {
      const indent = " ".repeat(Math.min(t.depth, 6) * 2);
      const stats = ` ${fmtCpu(t.cpu).padStart(5)} ${fmtMem(t.proc.memory).padStart(5)} ${String(t.proc.pid).padStart(6)}`;
      const cmd = prettyCommand(t.proc.cmdline, t.proc.cwd, t.proc.exe) || t.proc.exe;
      add(`${pad(fit(`${indent}${t.depth ? "└ " : ""}${cmd}`, inner - stats.length), inner - stats.length)}${stats}`, t.proc.pid === u.rep.pid ? T.fg : T.dim);
    }
    if (u.tree.length > room) add(`  … ${u.tree.length - room} more`, T.dim);
  }

  return (
    <box title=" details " style={{ ...panel, borderColor: ACCENT }}>
      <ActionBar width={inner} items={[btn("↪ cd there", T.teal, onCd)]} trailing={[]} />
      {lines.slice(0, Math.max(1, height - 2)).map((l, i) => (
        <text key={i} fg={l.color}>
          {l.bold ? <strong>{pad(fit(l.text, inner), inner)}</strong> : pad(fit(l.text, inner), inner)}
        </text>
      ))}
    </box>
  );
}

// ─── formatting ───────────────────────────────────────────────────────────────

function fmtCpu(cores: number): string {
  const pct = Math.round(cores * 100);
  if (pct <= 0) return cores > 0 ? "<1%" : "";
  return `${pct}%`;
}

function cpuColor(cores: number): string {
  if (cores >= 0.9) return T.red;
  if (cores >= 0.3) return T.yellow;
  if (cores >= 0.05) return T.fg;
  return T.dim;
}

function memColor(bytes: number): string {
  if (bytes >= 1024 ** 3) return T.red;
  if (bytes >= 600 * 1024 ** 2) return T.yellow;
  return T.dim;
}

function fmtMem(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

function fmtUp(startedAt: number): string {
  if (!startedAt) return "";
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
