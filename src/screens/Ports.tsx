import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ActionBar, btn, seg, type BarItem } from "../components/ActionBar.tsx";
import { Footer } from "../components/Footer.tsx";
import { fit, pad, wrap } from "../lib/text.ts";
import { fuzzyMatch } from "../lib/fuzzy.ts";
import { openInChrome } from "../lib/run.ts";
import { projectsRoot } from "../lib/projects.ts";
import { exeName, leaf, prettyCommand, projectOf } from "../lib/proctext.ts";
import {
  killServer,
  lanAddress,
  probe,
  scanServers,
  urlFor,
  type ProcInfo,
  type Probe,
  type Scan,
  type Server,
} from "../lib/ports.ts";

const ACCENT = T.blue;
const SCAN_MS = 2000;
const ARM_MS = 3000;
const FLASH_MS = 4000;
const DETAIL_MIN = 44;

type SortMode = "port" | "project" | "uptime" | "memory";
const SORTS: SortMode[] = ["port", "project", "uptime", "memory"];

interface Props {
  /** cd the shell into a directory and quit (the picker's handoff). */
  choose: (dir: string) => void;
  back: () => void;
}

interface Row {
  server: Server;
  project: { name: string; sub: string };
  command: string;
  port: number;
  url: string;
}

interface Armed {
  pid: number;
  scope: "chain" | "listener";
  until: number;
}

interface Flash {
  text: string;
  color: string;
  until: number;
}

export function Ports({ choose, back }: Props) {
  const [all, setAll] = useState(false);
  // First scan happens during the first render — an empty first frame paints
  // torn rows (ui.md, Painting). It's ~35ms.
  const [scan, setScan] = useState<Scan>(() => scanServers({ all: false }));
  const [sort, setSort] = useState<SortMode>("port");
  const [filter, setFilter] = useState("");
  const [typing, setTyping] = useState(false);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [top, setTop] = useState(0);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [frame, setFrame] = useState(0);
  const lastIndex = useRef(0);
  const lan = useMemo(() => lanAddress(), []);
  const { width, height } = useTerminalDimensions();

  const rescan = (everything = all) => setScan(scanServers({ all: everything }));

  useEffect(() => {
    const t = setInterval(() => setScan(scanServers({ all })), SCAN_MS);
    return () => clearInterval(t);
  }, [all]);

  // One tick drives spinners, probe results landing, and armed/flash expiry.
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  if (armed && armed.until < now) setArmed(null);
  if (flash && flash.until < now) setFlash(null);

  const root = useMemo(() => projectsRoot(), []);
  const rows = useMemo<Row[]>(() => {
    const built = scan.servers.map<Row>((server) => {
      const port = server.listeners[0]?.port ?? 0;
      return {
        server,
        project: projectOf(server.proc.cwd, root),
        command: prettyCommand(server.proc.cmdline, server.proc.cwd, server.proc.exe),
        port,
        url: urlFor(port),
      };
    });
    const q = filter.trim().toLowerCase();
    const kept = q
      ? built.filter((r) => {
          // Fuzzy only on the short project label — across a long command line
          // any five letters match somewhere. Ports and commands are substring.
          if (fuzzyMatch(projectLabel(r), q)) return true;
          const hay = `${r.server.listeners.map((l) => `:${l.port}`).join(" ")} ${r.command} ${r.server.proc.cwd}`.toLowerCase();
          return hay.includes(q);
        })
      : built;
    const by: Record<SortMode, (a: Row, b: Row) => number> = {
      port: (a, b) => a.port - b.port,
      project: (a, b) => a.project.name.localeCompare(b.project.name) || a.port - b.port,
      uptime: (a, b) => (a.server.proc.startedAt || now) - (b.server.proc.startedAt || now),
      memory: (a, b) => b.server.proc.memory - a.server.proc.memory,
    };
    return [...kept].sort(by[sort]);
    // `now` is deliberately not a dep — uptime sort only needs to refresh per scan.
  }, [scan, filter, sort, root]);

  // --- geometry (explicit everywhere: nothing may size to its content) -------
  const showDetail = width >= 110;
  const listWidth = showDetail ? Math.max(70, Math.min(width - DETAIL_MIN - 2, Math.floor(width * 0.56))) : width - 2;
  const detailWidth = width - listWidth - 3;
  const inner = listWidth - 4; // border 2 + padding 2
  const pw = projectWidth(inner, rows);
  // header 3 + border 2 + filter, column header, action bar, status 4 + bottom margin 1 + footer 1
  const visRows = Math.max(3, height - 11);

  const count = rows.length;
  const found = selectedPid === null ? -1 : rows.findIndex((r) => r.server.proc.pid === selectedPid);
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
    if (r) setSelectedPid(r.server.proc.pid);
  };

  const say = (text: string, color: string) => setFlash({ text, color, until: Date.now() + FLASH_MS });

  const open = (row: Row | null, url?: string) => {
    if (!row) return;
    const target = url ?? row.url;
    openInChrome(target);
    say(`↗ opened ${target}`, T.cyan);
  };

  const copy = (row: Row | null) => {
    if (!row) return;
    copyToClipboard(row.url);
    say(`⧉ copied ${row.url}`, T.cyan);
  };

  /** First press arms, second press within ARM_MS kills. */
  const kill = (row: Row | null, scope: "chain" | "listener") => {
    if (!row) return;
    const pid = row.server.proc.pid;
    if (!armed || armed.pid !== pid || armed.scope !== scope) {
      setArmed({ pid, scope, until: Date.now() + ARM_MS });
      return;
    }
    setArmed(null);
    const target = scope === "chain" ? row.server.killRoot : row.server.proc;
    killServer(row.server, scope);
    const ports = [row.port, ...(scope === "chain" ? row.server.alsoStops : [])].map((p) => `:${p}`).join(" ");
    say(`✓ killed ${row.project.name} — ${prettyCommand(target.cmdline, target.cwd, target.exe)} (pid ${target.pid}) · freed ${ports}`, T.green);
    rescan();
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
    if (key.name === "return") return open(current);
    if (key.name === "x" && key.shift) return kill(current, "listener");
    switch (key.sequence) {
      case "x":
        return kill(current, "chain");
      case "o":
        return open(current);
      case "c":
        return copy(current);
      case "g":
        return cdThere(current);
      case "r":
        rescan();
        return say("↻ rescanned", T.dim);
      case "s":
        return setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length] ?? "port");
      case "a":
        return showAll(!all);
      case "/":
        return setTyping(true);
    }
  });

  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";

  const showAll = (next: boolean) => {
    setAll(next);
    rescan(next);
  };
  const cdThere = (row: Row | null) => {
    if (row?.server.proc.cwd) choose(row.server.proc.cwd);
    else if (row) say("✗ can't read that process's working directory", T.red);
  };
  // Screen-level controls only — row actions (↗ ✕) live on the row, copy/cd in the detail pane.
  const actions: BarItem[] = [
    seg("", ["node+bun", "all"], all ? "all" : "node+bun", (v) => showAll(v === "all")),
    seg("sort", SORTS, sort, setSort, { project: "proj", uptime: "up", memory: "mem" }),
  ];
  const trailing: BarItem[] = [
    btn("↻ rescan", T.cyan, () => {
      rescan();
      say("↻ rescanned", T.dim);
    }),
    btn("← back", T.dim, back),
  ];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <box
          title=" localhost "
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
          <text fg={T.dim}>{columnHeader(inner, pw)}</text>
          <box
            style={{ flexDirection: "column", height: visRows, width: inner, flexShrink: 0, backgroundColor: T.panel }}
            onMouseScroll={(e) => {
              if (e.scroll) select(index + (e.scroll.direction === "up" ? -3 : 3));
            }}
          >
            {count === 0 ? (
              <text fg={T.dim}>{pad(emptyText(scan, filter, all), inner)}</text>
            ) : (
              windowRows.map((row) => (
                <ServerRow
                  key={row.server.proc.pid}
                  row={row}
                  width={inner}
                  projectW={pw}
                  selected={row === current}
                  armed={armed?.pid === row.server.proc.pid ? armed.scope : null}
                  spin={spin}
                  onHover={() => setSelectedPid(row.server.proc.pid)}
                  onOpen={() => open(row)}
                  onKill={() => {
                    setSelectedPid(row.server.proc.pid);
                    kill(row, "chain");
                  }}
                />
              ))
            )}
          </box>
          <ActionBar width={inner} items={actions} trailing={trailing} />
          <StatusLine
            width={inner}
            scan={scan}
            rows={rows}
            topRow={topRow}
            visRows={visRows}
            armed={armed}
            current={current}
            flash={flash}
            all={all}
          />
        </box>
        {showDetail && (
          <Detail
            row={current}
            width={detailWidth}
            lan={lan}
            spin={spin}
            armed={armed}
            onOpen={(url) => open(current, url)}
            onCopy={() => copy(current)}
            onCd={() => cdThere(current)}
          />
        )}
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
                ["enter", "open"],
                ["esc", armed ? "disarm" : filter ? "clear filter" : "back"],
              ]
        }
      />
    </box>
  );
}

// ─── list pieces ──────────────────────────────────────────────────────────────

const PORT_W = 10; // "● :64027+1"
const RT_W = 5; // " node"
const UP_W = 5;
const MEM_W = 6;
const BTN_W = 9; // " " + [ ↗ ] + " " + [ ✕? ]

/** Everything between the port and the runtime: project column + command column. */
function middleWidth(width: number): number {
  return Math.max(16, width - 2 - PORT_W - 1 - RT_W - UP_W - MEM_W - BTN_W);
}

/** The project column takes what the longest label needs, within reason; the command gets the rest. */
function projectWidth(width: number, rows: Row[]): number {
  const longest = rows.reduce((n, r) => Math.max(n, projectLabel(r).length), 7);
  return Math.min(longest + 2, Math.floor(middleWidth(width) * 0.45));
}

function projectLabel(r: Row): string {
  return r.project.sub ? `${r.project.name}/${r.project.sub}` : r.project.name;
}

function columnHeader(width: number, pw: number): string {
  const cw = middleWidth(width) - pw;
  return pad(`  ${pad("  port", PORT_W)} ${pad("project", pw)}${pad("command", cw)}${pad(" rt", RT_W)}${"up".padStart(UP_W)}${"mem".padStart(MEM_W)}`, width);
}

/** The filter row: a `⌕ filter` button, or the filter being typed with a `✕` to drop it. */
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
  const clear = btn("✕ clear", T.red, onClear);
  const textW = Math.max(4, width - 11);
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <box style={{ height: 1, width: textW }} onMouseDown={onStart}>
        <text>
          <span fg={typing ? T.yellow : T.fg}>{fit(`/ ${filter}`, textW - 1)}</span>
          <span fg={T.yellow}>{pad(caret, Math.max(1, textW - Math.min(filter.length + 2, textW - 1)))}</span>
        </text>
      </box>
      <ActionBar width={width - textW} items={[]} trailing={[clear]} />
    </box>
  );
}

function ServerRow({
  row,
  width,
  projectW,
  selected,
  armed,
  spin,
  onHover,
  onOpen,
  onKill,
}: {
  row: Row;
  width: number;
  projectW: number;
  selected: boolean;
  armed: "chain" | "listener" | null;
  spin: string;
  onHover: () => void;
  onOpen: () => void;
  onKill: () => void;
}) {
  const { server } = row;
  const p = probe(server.proc.pid, row.port);
  const dot = health(p, spin);
  const cmdW = middleWidth(width) - projectW;
  const extra = server.listeners.length > 1 ? `+${server.listeners.length - 1}` : "";
  const portText = pad(`:${row.port}`, PORT_W - 2 - extra.length);
  // name loud, monorepo sub-path dim, both inside the fixed project column
  const nameText = fit(row.project.name || "·", projectW - 1);
  const subText = row.project.sub ? fit(`/${row.project.sub}`, Math.max(0, projectW - 1 - nameText.length)) : "";
  const gap = " ".repeat(Math.max(0, projectW - nameText.length - subText.length));
  const cmdText = pad(row.command, cmdW);
  const bg = armed ? T.surface : selected ? T.selectionBg : T.panel;

  return (
    <box
      style={{ flexDirection: "row", height: 1, width, backgroundColor: bg }}
      onMouseOver={onHover}
      onMouseDown={onOpen}
    >
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={dot.color}>{`${dot.glyph} `}</span>
        <span fg={selected ? ACCENT : T.fg}>{portText}</span>
        <span fg={T.dim}>{extra}</span>
        <span fg={T.dim}>{" "}</span>
        <span fg={armed ? T.red : selected ? T.teal : T.fg}>{nameText}</span>
        <span fg={T.dim}>{subText}</span>
        <span>{gap}</span>
        <span fg={selected ? T.fg : T.dim}>{cmdText}</span>
        <span fg={runtimeColor(server.runtime)}>{pad(` ${server.runtime === "other" ? "·" : server.runtime}`, RT_W)}</span>
        <span fg={T.dim}>{fmtUp(server.proc.startedAt).padStart(UP_W)}</span>
        <span fg={memColor(server.proc.memory)}>{fmtMem(server.proc.memory).padStart(MEM_W)}</span>
        <span>{" "}</span>
      </text>
      <RowButton label="↗" color={T.cyan} width={3} onPress={onOpen} />
      <box style={{ width: 1, height: 1 }} />
      <RowButton label={armed ? "✕?" : "✕"} color={T.red} width={4} hot={armed !== null} onPress={onKill} />
    </box>
  );
}

/** Fixed-width button — the armed label is wider, and a box that resizes leaves paint behind. */
function RowButton({
  label,
  color,
  width,
  hot = false,
  onPress,
}: {
  label: string;
  color: string;
  width: number;
  hot?: boolean;
  onPress: () => void;
}) {
  return (
    <box
      style={{ width, height: 1, flexShrink: 0, backgroundColor: hot ? T.red : T.surfaceAlt }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onPress();
      }}
    >
      <text fg={hot ? T.bg : color}>{pad(` ${label}`, width)}</text>
    </box>
  );
}

function StatusLine({
  width,
  scan,
  rows,
  topRow,
  visRows,
  armed,
  current,
  flash,
  all,
}: {
  width: number;
  scan: Scan;
  rows: Row[];
  topRow: number;
  visRows: number;
  armed: Armed | null;
  current: Row | null;
  flash: Flash | null;
  all: boolean;
}) {
  if (armed && current) {
    const s = current.server;
    const target = armed.scope === "chain" ? s.killRoot : s.proc;
    const more = armed.scope === "chain" && s.killCount > 1 ? ` + ${s.killCount - 1} more` : "";
    const also = armed.scope === "chain" && s.alsoStops.length ? ` · also stops ${s.alsoStops.map((p) => `:${p}`).join(" ")}` : "";
    const key = armed.scope === "chain" ? "x" : "shift+x";
    return (
      <text fg={T.red}>
        {pad(`⚠ kill ${prettyCommand(target.cmdline, target.cwd, target.exe)} (pid ${target.pid})${more}${also} — ${key} again`, width)}
      </text>
    );
  }
  if (flash) return <text fg={flash.color}>{pad(flash.text, width)}</text>;
  const n = rows.length;
  const total = scan.servers.length;
  const range = n > visRows ? ` · ${topRow + 1}–${Math.min(n, topRow + visRows)} of ${n}` : "";
  const filtered = n !== total ? ` (${total} total)` : "";
  const what = all ? "listener" : "server";
  return <text fg={T.dim}>{pad(`${n} ${what}${n === 1 ? "" : "s"}${filtered}${range} · live, every ${SCAN_MS / 1000}s`, width)}</text>;
}

// ─── detail pane ──────────────────────────────────────────────────────────────

function Detail({
  row,
  width,
  lan,
  spin,
  armed,
  onOpen,
  onCopy,
  onCd,
}: {
  row: Row | null;
  width: number;
  lan: string | null;
  spin: string;
  armed: Armed | null;
  onOpen: (url: string) => void;
  onCopy: () => void;
  onCd: () => void;
}) {
  const inner = width - 4;
  const panel = {
    width,
    flexShrink: 0,
    flexDirection: "column" as const,
    border: true,
    borderStyle: "rounded" as const,
    titleColor: ACCENT,
    margin: 1,
    marginTop: 0,
    padding: 1,
    paddingTop: 0,
    backgroundColor: T.panel,
  };
  if (!row) {
    return (
      <box title=" details " style={{ ...panel, borderColor: T.border }}>
        <text fg={T.dim}>{pad("nothing selected", inner)}</text>
      </box>
    );
  }

  const s = row.server;
  const p = probe(s.proc.pid, row.port);
  const isArmed = armed?.pid === s.proc.pid;
  const chain = killChain(s);
  const above = s.ancestors.slice(chain.length - 1, chain.length + 2).reverse();
  const cwdParent = s.proc.cwd.slice(0, Math.max(0, s.proc.cwd.length - leaf(s.proc.cwd).length));

  return (
    <box title={` ${row.project.name || exeName(s.proc.exe)} `} style={{ ...panel, borderColor: isArmed ? T.red : ACCENT }}>
      <text>
        <span fg={T.fg}>
          <strong>{fit(row.project.name ? projectLabel(row) : exeName(s.proc.exe), inner - 8)}</strong>
        </span>
        <span fg={runtimeColor(s.runtime)}>{`  ${s.runtime === "other" ? exeName(s.proc.exe) : s.runtime}`}</span>
      </text>
      <text fg={p?.title ? T.fg : T.dim}>{pad(pageLine(p, spin), inner)}</text>
      <ActionBar width={inner} items={[btn("⧉ copy url", T.cyan, onCopy), btn("↪ cd there", T.teal, onCd)]} trailing={[]} />

      <text fg={T.dim}>{pad("", inner)}</text>
      <text fg={T.dim}>{pad("links", inner)}</text>
      {s.listeners.map((l) => {
        const url = urlFor(l.port);
        const exposed = l.addrs.some((a) => a !== "127.0.0.1" && a !== "::1");
        return (
          <box key={l.port} style={{ flexDirection: "column", width: inner }}>
            <box style={{ height: 1, width: inner }} onMouseDown={() => onOpen(url)}>
              <text>
                <span fg={T.cyan}>{`↗ ${url}`}</span>
                <span fg={T.dim}>{pad(`  ${bindLabel(l.addrs)}`, Math.max(0, inner - url.length - 2))}</span>
              </text>
            </box>
            {exposed && lan ? (
              <box style={{ height: 1, width: inner }} onMouseDown={() => onOpen(urlFor(l.port, lan))}>
                <text>
                  <span fg={T.blue}>{`↗ ${urlFor(l.port, lan)}`}</span>
                  <span fg={T.dim}>{pad("  lan", Math.max(0, inner - urlFor(l.port, lan).length - 2))}</span>
                </text>
              </box>
            ) : null}
          </box>
        );
      })}

      <text fg={T.dim}>{pad("", inner)}</text>
      <text>
        <span fg={T.teal}>{"⌂ "}</span>
        <span fg={T.dim}>{fit(cwdParent, Math.max(0, inner - 2 - leaf(s.proc.cwd).length))}</span>
        <span fg={T.teal}>
          <strong>{fit(leaf(s.proc.cwd) || "(cwd unreadable)", inner - 2)}</strong>
        </span>
      </text>
      <text fg={T.fg}>{pad(`▸ ${row.command}`, inner)}</text>
      {wrap(s.proc.cmdline || "(command line unreadable)", inner - 2)
        .slice(0, 3)
        .map((line, i) => (
          <text key={i} fg={T.dim}>
            {pad(`  ${line}`, inner)}
          </text>
        ))}

      <text fg={T.dim}>{pad("", inner)}</text>
      <text fg={T.dim}>{pad(s.runtime === "other" ? "process" : "kill chain", inner)}</text>
      {above.map((a) => (
        <text key={a.pid} fg={T.dim}>
          {pad(`  ${procLabel(a, inner - 10)}`, inner)}
        </text>
      ))}
      {chain.map((c, i) => {
        const isRoot = i === 0;
        const isListener = c.pid === s.proc.pid;
        const glyph = isRoot ? "✕" : "└";
        const color = isArmed ? T.red : isRoot ? T.red : isListener ? T.fg : T.dim;
        const ports = isListener ? `  ${s.listeners.map((l) => `:${l.port}`).join(" ")}` : "";
        const indent = " ".repeat(Math.min(i, 6));
        const label = `${indent}${glyph} ${procLabel(c, Math.max(8, inner - indent.length - 2 - ports.length))}`;
        return (
          <text key={c.pid}>
            <span fg={color}>{label}</span>
            <span fg={ACCENT}>{pad(ports, Math.max(0, inner - label.length))}</span>
          </text>
        );
      })}
      <text fg={T.dim}>
        {pad(s.killCount > chain.length ? `  ✕ stops ${s.killCount} processes in this tree` : `  ✕ stops ${s.killCount} process${s.killCount === 1 ? "" : "es"}`, inner)}
      </text>
      {s.alsoStops.length > 0 ? (
        <text fg={T.yellow}>{pad(`  ⚠ also stops ${s.alsoStops.map((p) => `:${p}`).join(" ")} — shift+x kills just this one`, inner)}</text>
      ) : null}

      <text fg={T.dim}>{pad("", inner)}</text>
      <text fg={T.dim}>
        {pad(`pid ${s.proc.pid} · up ${fmtUpLong(s.proc.startedAt)} · ${fmtMem(s.proc.memory) || "?"} working set`, inner)}
      </text>
    </box>
  );
}

/** killRoot → … → listener, top-down. */
function killChain(s: Server): ProcInfo[] {
  if (s.killRoot.pid === s.proc.pid) return [s.proc];
  const idx = s.ancestors.findIndex((a) => a.pid === s.killRoot.pid);
  if (idx < 0) return [s.proc];
  return [...s.ancestors.slice(0, idx + 1).reverse(), s.proc];
}

function procLabel(p: ProcInfo, width: number): string {
  const cmd = prettyCommand(p.cmdline, p.cwd, p.exe) || exeName(p.exe);
  const id = `  ${p.pid}`;
  return `${fit(cmd, Math.max(4, width - id.length))}${id}`;
}

function pageLine(p: Probe | null, spin: string): string {
  if (!p) return `${spin} probing…`;
  if (p.kind === "timeout") return "accepted the connection, no http answer in 4s";
  if (p.kind === "other") return "not http — websocket, debugger or raw tcp";
  if (p.title) return `“${p.title}”${p.status && p.status >= 400 ? `  (${p.status})` : ""}`;
  return `http ${p.status ?? "?"} · no page title`;
}

function bindLabel(addrs: string[]): string {
  const any = addrs.some((a) => a === "0.0.0.0" || a === "::");
  if (any) return "all interfaces";
  if (addrs.every((a) => a === "127.0.0.1" || a === "::1")) return "loopback";
  return addrs.join(" ");
}

// ─── formatting ───────────────────────────────────────────────────────────────

function health(p: Probe | null, spin: string): { glyph: string; color: string } {
  if (!p) return { glyph: spin, color: T.yellow };
  if (p.kind === "timeout") return { glyph: "◌", color: T.yellow };
  if (p.kind === "other") return { glyph: "○", color: T.dim };
  if ((p.status ?? 0) >= 500) return { glyph: "●", color: T.red };
  return { glyph: "●", color: T.green };
}

function runtimeColor(rt: Server["runtime"]): string {
  return rt === "node" ? T.green : rt === "bun" ? T.orange : T.dim;
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

function fmtUpLong(startedAt: number): string {
  if (!startedAt) return "?";
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function emptyText(scan: Scan, filter: string, all: boolean): string {
  if (scan.error) return scan.error;
  if (filter) return `Nothing matches "${filter}" — esc clears the filter`;
  return all ? "Nothing is listening on TCP" : "No node or bun process is listening — press a to see every listener";
}

function copyToClipboard(text: string): void {
  const cmd = process.platform === "win32" ? ["clip"] : process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    void proc.stdin.end();
  } catch {
    /* no clipboard tool */
  }
}
