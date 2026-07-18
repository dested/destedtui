import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { Footer } from "../components/Footer.tsx";
import type { PackageInfo } from "../lib/discovery.ts";
import { runScript, type OutputLine, type ProcHandle } from "../lib/run.ts";

interface Props {
  pkg: PackageInfo;
  script: string;
  back: () => void;
}

const MAX_LINES = 4000;

export function ProcessView({ pkg, script, back }: Props) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const handleRef = useRef<ProcHandle | null>(null);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const pending: OutputLine[] = [];
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    const handle = runScript(pkg, script, (line) => {
      pending.push(line);
    });
    handleRef.current = handle;
    flushTimer = setInterval(() => {
      if (pending.length) {
        const batch = pending.splice(0, pending.length);
        setLines((prev) => {
          const next = [...prev, ...batch];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 80);
    handle.exited.then((code) => setExitCode(code));
    return () => {
      if (flushTimer) clearInterval(flushTimer);
      handle.kill();
    };
  }, [pkg, script]);

  useEffect(() => {
    if (exitCode !== null) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, [exitCode]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      handleRef.current?.kill();
      back();
    } else if (key.name === "x" && key.ctrl) {
      handleRef.current?.kill();
    }
  });

  const running = exitCode === null;
  const statusColor = running ? T.yellow : exitCode === 0 ? T.green : T.red;
  const statusText = running
    ? `${SPINNER_FRAMES[frame]} running · ${elapsed}s`
    : exitCode === 0
      ? `✓ done in ${elapsed}s`
      : `✗ exit ${exitCode}`;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title={` ${pkg.name} › ${script} `}
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: running ? T.border : exitCode === 0 ? T.green : T.red,
          titleColor: T.cyan,
          margin: 1,
          marginTop: 0,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, height: 1 }}>
          <text fg={T.dim}>{`${pkg.pm} run ${script}  ·  ${pkg.rel}`}</text>
          <text fg={statusColor}>{statusText}</text>
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
          {lines.map((line, i) => (
            <text key={i} fg={line.stream === "stderr" ? T.orange : line.stream === "info" ? T.dim : T.fg}>
              {line.text || " "}
            </text>
          ))}
        </scrollbox>
      </box>
      <Footer
        hints={
          running
            ? [
                ["ctrl+x", "kill"],
                ["esc", "kill & back"],
                ["scroll", "mouse/arrows"],
              ]
            : [
                ["esc", "back"],
                ["scroll", "mouse/arrows"],
              ]
        }
      />
    </box>
  );
}
