import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { Footer } from "../components/Footer.tsx";
import { Button } from "../components/ProjectCard.tsx";
import { pad } from "../lib/text.ts";
import { openInChrome } from "../lib/run.ts";
import { startup, type AppRuntime, type Phase } from "../lib/startup.ts";

const RAIL_WIDTH = 40;
const CARD_HEIGHT = 5; // border 2 + 3 inner lines

interface Props {
  back: () => void;
}

export function Startup({ back }: Props) {
  const [, force] = useState(0);
  const [selected, setSelected] = useState(0);
  const [frame, setFrame] = useState(0);
  const rev = useRef(-1);

  // Auto-start the whole fleet the first time the dashboard opens. The manager
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

  // Its own tick so spinners spin and the elapsed clock ticks while idle.
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 100);
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
    }
  });

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <Rail apps={apps} index={index} frame={frame} onSelect={setSelected} />
        <Console app={sel} frame={frame} />
      </box>
      <Footer
        hints={[
          ["↑↓", "select"],
          ["s", "start"],
          ["x", "stop"],
          ["r", "restart"],
          ["o", "open"],
          ["a", "all"],
          ["shift+x", "stop all"],
          ["esc", "back"],
        ]}
      />
    </box>
  );
}

function Rail({
  apps,
  index,
  frame,
  onSelect,
}: {
  apps: AppRuntime[];
  index: number;
  frame: number;
  onSelect: (i: number) => void;
}) {
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
          <AppRow key={app.spec.id} app={app} selected={i === index} frame={frame} onSelect={() => onSelect(i)} />
        ))}
      </box>
      <box style={{ flexDirection: "row", gap: 1, height: 1, marginTop: 1 }}>
        <Button label="▶ start all" color={T.green} onPress={() => startup.startAll()} />
        <Button label={anyRunning ? "■ stop all" : "—"} color={anyRunning ? T.red : T.dim} onPress={() => startup.stopAll()} />
      </box>
    </box>
  );
}

function AppRow({
  app,
  selected,
  frame,
  onSelect,
}: {
  app: AppRuntime;
  selected: boolean;
  frame: number;
  onSelect: () => void;
}) {
  const inner = RAIL_WIDTH - 4; // border 2 + rail padding 2
  const width = inner; // card sits flush inside the rail padding
  const pad2 = width - 4; // card border 2 + card padding 2
  const running = app.handle !== null;
  const dot = phaseDot(app.phase, frame);
  const nameWidth = Math.max(1, pad2 - app.spec.note.length - 3);
  // Hoisted so the button closure narrows without a non-null assertion.
  const url = app.spec.url;

  return (
    <box
      style={{
        width,
        height: CARD_HEIGHT,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: selected ? app.spec.accent : T.border,
        backgroundColor: selected ? T.selectionBg : T.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      onMouseOver={onSelect}
      onMouseDown={onSelect}
    >
      <text>
        <span fg={dot.color}>{`${dot.glyph} `}</span>
        <span fg={selected ? app.spec.accent : T.fg}>{pad(app.spec.name, nameWidth)}</span>
        <span fg={T.dim}>{` ${app.spec.note}`}</span>
      </text>
      <text fg={statusColor(app.phase)}>{pad(statusText(app, frame), pad2)}</text>
      <box style={{ flexDirection: "row", gap: 1, height: 1, width: pad2 }}>
        {running ? (
          <Button label="■ stop" color={T.red} onPress={() => startup.stop(app.spec.id)} />
        ) : (
          <Button label="▶ start" color={T.green} onPress={() => startup.start(app.spec.id)} />
        )}
        <Button label="⟳" color={T.yellow} onPress={() => startup.restart(app.spec.id)} />
        {url ? <Button label="↗ open" color={T.cyan} onPress={() => openInChrome(url)} /> : null}
      </box>
    </box>
  );
}

function Console({ app, frame }: { app: AppRuntime; frame: number }) {
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
        <text fg={statusColor(app.phase)}>{statusText(app, frame)}</text>
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
          <text fg={T.dim}>{app.phase === "stopped" ? "not running — press s to start" : "…"}</text>
        ) : (
          app.lines.map((line, i) => (
            <text key={i} fg={line.stream === "stderr" ? T.orange : line.stream === "info" ? T.dim : T.fg}>
              {line.text || " "}
            </text>
          ))
        )}
      </scrollbox>
    </box>
  );
}

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

function statusText(app: AppRuntime, frame: number): string {
  switch (app.phase) {
    case "booting":
      return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} starting… · ${elapsed(app.startedAt)}`;
    case "ready":
      return `running · ${elapsed(app.startedAt)}`;
    case "exited":
      return `exited (0)`;
    case "crashed":
      return `crashed (${app.exitCode})`;
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
