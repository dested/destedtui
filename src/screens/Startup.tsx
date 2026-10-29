import { memo, useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { Footer } from "../components/Footer.tsx";
import { Button } from "../components/ProjectCard.tsx";
import { pad } from "../lib/text.ts";
import { openInChrome, type OutputLine } from "../lib/run.ts";
import { startup, type AppRuntime, type AppSpec, type Phase } from "../lib/startup.ts";

const RAIL_WIDTH = 40;
const CARD_HEIGHT = 5; // border 2 + 3 inner lines

interface Props {
  back: () => void;
}

export function Startup({ back }: Props) {
  const [, force] = useState(0);
  const [selected, setSelected] = useState(0);
  const rev = useRef(-1);

  // Start the apps marked auto the first time the dashboard opens. The manager
  // guards against doing it twice, so coming back later leaves them running.
  useEffect(() => {
    startup.autoStart();
  }, []);

  // Poll the manager's revision instead of subscribing per line — heavy output
  // would otherwise re-render on every stdout chunk.
  useEffect(() => {
    const t = setInterval(() => {
      if (startup.revision !== rev.current) {
        rev.current = startup.revision;
        force((x) => x + 1);
      }
    }, 80);
    return () => clearInterval(t);
  }, []);

  const apps = startup.list();
  const index = Math.min(selected, apps.length - 1);
  const sel = apps[index]!;

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (key.name === "escape") return back();
    if (key.name === "up") return setSelected((s) => (s - 1 + apps.length) % apps.length);
    if (key.name === "down") return setSelected((s) => (s + 1) % apps.length);
    if (key.name === "return") {
      if (sel.spec.url) openInChrome(sel.spec.url);
      return;
    }
    // Shift+x = stop everything; lowercase letters are per-app actions. No text
    // input on this screen, so bare letters are safe to bind.
    if (key.name === "x" && key.shift) return startup.stopAll();
    switch (key.sequence) {
      case "s":
        return startup.start(sel.spec.id);
      case "x":
        return startup.stop(sel.spec.id);
      case "r":
        return startup.restart(sel.spec.id);
      case "o":
        if (sel.spec.url) openInChrome(sel.spec.url);
        return;
      case "a":
        return startup.startAll();
      case "c":
        return startup.clearLog(sel.spec.id);
      case "t":
        return startup.toggleAuto(sel.spec.id);
    }
  });

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <Rail apps={apps} index={index} onSelect={setSelected} />
        <Console app={sel} />
      </box>
      <Footer
        hints={[
          ["↑↓", "select"],
          ["s", "start"],
          ["x", "stop"],
          ["r", "restart"],
          ["o", "open"],
          ["a", "all"],
          ["t", "auto"],
          ["shift+x", "stop all"],
          ["esc", "back"],
        ]}
      />
    </box>
  );
}

function Rail({ apps, index, onSelect }: { apps: AppRuntime[]; index: number; onSelect: (i: number) => void }) {
  const anyRunning = apps.some((a) => a.handle);
  return (
    <box
      title=" startup "
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: T.border,
        titleColor: T.teal,
        margin: 1,
        marginRight: 0,
        padding: 1,
        backgroundColor: T.panel,
      }}
    >
      <box style={{ flexDirection: "column", gap: 1, flexGrow: 1 }}>
        {apps.map((app, i) => (
          <AppRow
            key={app.spec.id}
            spec={app.spec}
            phase={app.phase}
            running={app.handle !== null}
            auto={startup.isAuto(app.spec.id)}
            startedAt={app.startedAt}
            exitCode={app.exitCode}
            selected={i === index}
            index={i}
            onSelect={onSelect}
          />
        ))}
      </box>
      <box style={{ flexDirection: "row", gap: 1, height: 1, marginTop: 1 }}>
        <Button label="▶ start all" color={T.green} onPress={() => startup.startAll()} />
        <Button label={anyRunning ? "■ stop all" : "—"} color={anyRunning ? T.red : T.dim} onPress={() => startup.stopAll()} />
      </box>
    </box>
  );
}

/**
 * One card, memoized on primitives (the runtime object is mutated in place, so
 * it can't be the memo key): it re-renders only when what it shows changes.
 * The spinner and the clock tick inside <Dot>/<Status>, see useTick.
 */
const AppRow = memo(function AppRow({
  spec,
  phase,
  running,
  auto,
  startedAt,
  exitCode,
  selected,
  index,
  onSelect,
}: {
  spec: AppSpec;
  phase: Phase;
  running: boolean;
  auto: boolean;
  startedAt: number | null;
  exitCode: number | null;
  selected: boolean;
  index: number;
  onSelect: (i: number) => void;
}) {
  const inner = RAIL_WIDTH - 4; // border 2 + rail padding 2
  const width = inner; // card sits flush inside the rail padding
  const pad2 = width - 4; // card border 2 + card padding 2
  const nameWidth = Math.max(1, pad2 - spec.note.length - 3);
  // Hoisted so the button closure narrows without a non-null assertion.
  const url = spec.url;
  const select = () => onSelect(index);

  return (
    <box
      style={{
        width,
        height: CARD_HEIGHT,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: selected ? spec.accent : T.border,
        backgroundColor: selected ? T.selectionBg : T.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      onMouseOver={select}
      onMouseDown={select}
    >
      <text>
        <Dot phase={phase} />
        <span fg={selected ? spec.accent : T.fg}>{pad(spec.name, nameWidth)}</span>
        <span fg={T.dim}>{` ${spec.note}`}</span>
      </text>
      <Status phase={phase} startedAt={startedAt} exitCode={exitCode} width={pad2} />
      <box style={{ flexDirection: "row", gap: 1, height: 1, width: pad2 }}>
        {running ? (
          <Button label="■ stop" color={T.red} onPress={() => startup.stop(spec.id)} />
        ) : (
          <Button label="▶ start" color={T.green} onPress={() => startup.start(spec.id)} />
        )}
        <Button label="⟳" color={T.yellow} onPress={() => startup.restart(spec.id)} />
        {url ? <Button label="↗ open" color={T.cyan} onPress={() => openInChrome(url)} /> : null}
        <Button label={auto ? "◉ auto" : "○ auto"} color={auto ? T.teal : T.dim} onPress={() => startup.toggleAuto(spec.id)} />
      </box>
    </box>
  );
});

/**
 * Re-render every `ms`, or never when null. The spinner and the elapsed clock
 * tick in these leaf components on purpose: re-rendering the whole dashboard
 * every 100 ms grew the process by ~25-45 MB/min of native memory for as long as
 * it stayed open (opentui 0.4.3 / Bun 1.3.10 on Windows: 19 GB over a 13 h day),
 * and that cost scales with the subtree that re-renders, not with what changed.
 * See plans/2026-10-07-memory-leak.md.
 */
function useTick(ms: number | null): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

/** The phase dot: a spinner while booting (10 fps), otherwise static. */
function Dot({ phase }: { phase: Phase }) {
  const frame = useTick(phase === "booting" ? 100 : null);
  const dot = phaseDot(phase, frame);
  return <span fg={dot.color}>{`${dot.glyph} `}</span>;
}

/** Status line: spinner + clock while booting, a 1 s clock while running. */
function Status({
  phase,
  startedAt,
  exitCode,
  width,
}: {
  phase: Phase;
  startedAt: number | null;
  exitCode: number | null;
  width?: number;
}) {
  const frame = useTick(phase === "booting" ? 100 : phase === "ready" ? 1000 : null);
  const text = statusText(phase, startedAt, exitCode, frame);
  return <text fg={statusColor(phase)}>{width === undefined ? text : pad(text, width)}</text>;
}

function Console({ app }: { app: AppRuntime }) {
  return (
    <box
      title={` ${app.spec.name} console `}
      style={{
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: app.handle ? app.spec.accent : app.phase === "crashed" ? T.red : T.border,
        titleColor: T.cyan,
        margin: 1,
        backgroundColor: T.panel,
      }}
    >
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text fg={T.dim}>{`${app.spec.command}  ·  ${app.spec.dir}`}</text>
        <Status phase={app.phase} startedAt={app.startedAt} exitCode={app.exitCode} />
      </box>
      <scrollbox
        focused
        stickyScroll
        style={{
          flexGrow: 1,
          rootOptions: { backgroundColor: T.bg },
          viewportOptions: { backgroundColor: T.bg },
          contentOptions: { backgroundColor: T.bg },
        }}
      >
        {app.lines.length === 0 ? (
          <text fg={T.dim}>{app.phase === "stopped" ? startup.isAuto(app.spec.id) ? "not running — press s to start" : "not running — s to start, t to start it whenever the dashboard opens" : "…"}</text>
        ) : (
          <ConsoleLines lines={app.lines} total={app.total} />
        )}
      </scrollbox>
    </box>
  );
}

/**
 * The scrollback, memoized so a re-render of the console (status, selection)
 * doesn't reconcile up to MAX_LINES <text>s. `lines` is mutated in place, so
 * `total` is what tells memo a line arrived; a clear swaps the array. Keys are
 * absolute line numbers, so trimming the front drops one node instead of
 * rewriting every line's text.
 */
const ConsoleLines = memo(function ConsoleLines({ lines, total }: { lines: OutputLine[]; total: number }) {
  const first = total - lines.length;
  return lines.map((line, i) => (
    <text key={first + i} fg={line.stream === "stderr" ? T.orange : line.stream === "info" ? T.dim : T.fg}>
      {line.text || " "}
    </text>
  ));
});

function phaseDot(phase: Phase, frame: number): { glyph: string; color: string } {
  switch (phase) {
    case "booting":
      return { glyph: SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!, color: T.yellow };
    case "ready":
      return { glyph: "●", color: T.green };
    case "crashed":
      return { glyph: "✗", color: T.red };
    case "exited":
      return { glyph: "●", color: T.dim };
    default:
      return { glyph: "○", color: T.dim };
  }
}

function statusColor(phase: Phase): string {
  switch (phase) {
    case "booting":
      return T.yellow;
    case "ready":
      return T.green;
    case "crashed":
      return T.red;
    default:
      return T.dim;
  }
}

function statusText(phase: Phase, startedAt: number | null, exitCode: number | null, frame: number): string {
  switch (phase) {
    case "booting":
      return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} starting… · ${elapsed(startedAt)}`;
    case "ready":
      return `running · ${elapsed(startedAt)}`;
    case "exited":
      return `exited (0)`;
    case "crashed":
      return `crashed (${exitCode})`;
    default:
      return "stopped";
  }
}

function elapsed(startedAt: number | null): string {
  if (!startedAt) return "0s";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}
