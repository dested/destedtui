import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ListPicker } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import type { DatabaseInfo, Discovery } from "../lib/discovery.ts";
import { startBackup, type BackupEvent, type BackupJob, type BackupResult } from "../lib/backup.ts";
import { fmtBytes } from "../lib/pgtools.ts";

interface Props {
  discovery: Discovery;
  back: () => void;
}

type Phase = "pick" | "running" | "done" | "error";

export function Backup({ discovery, back }: Props) {
  const [phase, setPhase] = useState<Phase>(discovery.databases.length === 1 ? "pick" : "pick");
  const [events, setEvents] = useState<BackupEvent[]>([]);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [errorText, setErrorText] = useState("");
  const [frame, setFrame] = useState(0);
  const jobRef = useRef<BackupJob | null>(null);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, [phase]);

  const run = (db: DatabaseInfo) => {
    setEvents([]);
    setPhase("running");
    const job = startBackup(db, (e) => {
      setEvents((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        // collapse repeated progress updates for the same step
        if (last && last.step === e.step) next[next.length - 1] = e;
        else next.push(e);
        return next.slice(-14);
      });
    });
    jobRef.current = job;
    job.result
      .then((r) => {
        setResult(r);
        setPhase("done");
      })
      .catch((err) => {
        setErrorText(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (phase === "running") {
        jobRef.current?.cancel();
        setPhase("pick");
      } else {
        back();
      }
    } else if (key.name === "return" && (phase === "done" || phase === "error")) {
      back();
    }
  });

  const current = events[events.length - 1];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" pg backup "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: phase === "done" ? T.green : phase === "error" ? T.red : T.border,
          titleColor: T.blue,
          margin: 1,
          marginTop: 0,
          padding: 1,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        {phase === "pick" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>Pick a database — the zip lands next to its .env</text>
            <ListPicker
              vimKeys
              items={discovery.databases.map((db, i) => ({
                id: `${db.envPath}-${i}`,
                icon: "⛁",
                title: db.rel === "." ? "(this directory)" : db.rel,
                subtitle: db.redacted.slice(0, 70),
                badge: db.key,
                badgeColor: T.purple,
              }))}
              onSelect={(_item, index) => {
                const db = discovery.databases[index];
                if (db) run(db);
              }}
            />
          </box>
        )}

        {phase !== "pick" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            {events.map((e, i) => {
              const isLast = i === events.length - 1;
              const color =
                e.step === "error" ? T.red : e.step === "done" ? T.green : isLast && phase === "running" ? T.yellow : T.dim;
              const prefix =
                phase === "running" && isLast ? SPINNER_FRAMES[frame] : e.step === "error" ? "✗" : "✓";
              return (
                <text key={i} fg={color}>{`${prefix} ${e.detail}`}</text>
              );
            })}
            {phase === "running" && current?.pct !== undefined && <ProgressBar pct={current.pct} width={44} />}
            {phase === "done" && result && (
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                <text fg={T.green}>{`  ${result.database} · PostgreSQL ${result.serverVersion} · ${fmtBytes(result.zipBytes)}`}</text>
                <text fg={T.fg}>{`  ${result.zipPath}`}</text>
              </box>
            )}
            {phase === "error" && <text fg={T.red}>{errorText.slice(0, 500)}</text>}
          </box>
        )}
      </box>
      <Footer
        hints={
          phase === "pick"
            ? [
                ["↑↓", "select"],
                ["enter", "backup"],
                ["esc", "back"],
              ]
            : phase === "running"
              ? [["esc", "cancel"]]
              : [
                  ["enter/esc", "back"],
                ]
        }
      />
    </box>
  );
}
