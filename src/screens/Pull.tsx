import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ListPicker } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import type { DatabaseInfo, Discovery } from "../lib/discovery.ts";
import { parsePgUrl } from "../lib/pgurl.ts";
import { fmtBytes, msg } from "../lib/pgtools.ts";
import { startPull, type PullEvent, type PullJob, type PullResult } from "../lib/pull.ts";
import type { RestoreMode } from "../lib/restore.ts";
import {
  loadLocalConn,
  localPgConn,
  describeLocal,
  listLocalDatabases,
  type LocalConn,
  type LocalDbInfo,
} from "../lib/pglocal.ts";

interface Props {
  discovery: Discovery;
  back: () => void;
}

type Phase = "pickdb" | "connectlocal" | "typetarget" | "confirm" | "running" | "done" | "error";

export function Pull({ discovery, back }: Props) {
  const [phase, setPhase] = useState<Phase>("pickdb");
  const [local] = useState<LocalConn>(() => loadLocalConn());
  const [source, setSource] = useState<DatabaseInfo | null>(null);
  const [localDbs, setLocalDbs] = useState<LocalDbInfo[]>([]);
  const [targetName, setTargetName] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [mode, setMode] = useState<RestoreMode>("new");
  const [events, setEvents] = useState<PullEvent[]>([]);
  const [result, setResult] = useState<PullResult | null>(null);
  const [errorText, setErrorText] = useState("");
  const [frame, setFrame] = useState(0);
  const jobRef = useRef<PullJob | null>(null);

  const sourceDb = source ? parsePgUrl(source.url).database : "";

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, [phase]);

  const pickSource = (db: DatabaseInfo) => {
    setSource(db);
    setPhase("connectlocal");
    listLocalDatabases(localPgConn(local))
      .then((dbs) => {
        setLocalDbs(dbs);
        setPhase("typetarget");
      })
      .catch((err) => {
        setErrorText(
          `Couldn't reach local Postgres at ${describeLocal(local)}\n${msg(err)}\n\nFix the connection in the "Local Postgres" screen (menu), then try again.`,
        );
        setPhase("error");
      });
  };

  const submitTarget = (raw: string) => {
    const name = (raw.trim() || sourceDb).trim();
    if (!name) return;
    setTargetName(name);
    if (localDbs.some((d) => d.name === name)) {
      setMode("overwrite");
      setConfirmText("");
      setPhase("confirm");
    } else {
      setMode("new");
      runPull(name, "new");
    }
  };

  const runPull = (name: string, m: RestoreMode) => {
    if (!source) return;
    setEvents([]);
    setPhase("running");
    const job = startPull(source.url, { conn: localPgConn(local, name), mode: m }, (e) => {
      setEvents((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
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
    if (key.name === "return" && (phase === "done" || phase === "error")) {
      back();
      return;
    }
    if (key.name !== "escape") return;
    switch (phase) {
      case "running":
        jobRef.current?.cancel();
        setPhase("pickdb");
        break;
      case "connectlocal":
      case "typetarget":
        setPhase("pickdb");
        break;
      case "confirm":
        setConfirmText("");
        setPhase("typetarget");
        break;
      default:
        back();
    }
  });

  const current = events[events.length - 1];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" pull → local "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: phase === "done" ? T.green : phase === "error" ? T.red : T.border,
          titleColor: T.cyan,
          margin: 1,
          marginTop: 0,
          padding: 1,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        {phase === "pickdb" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>{`Which database do you want to clone into ${describeLocal(local)}?`}</text>
            <ListPicker
              vimKeys
              emptyText="No DATABASE_URL found in this tree"
              items={discovery.databases.map((d, i) => ({
                id: `${d.envPath}-${i}`,
                icon: "⛁",
                title: d.rel === "." ? "(this directory)" : d.rel,
                subtitle: d.redacted.slice(0, 60),
                badge: d.key,
                badgeColor: T.purple,
              }))}
              onSelect={(_item, index) => {
                const db = discovery.databases[index];
                if (db) pickSource(db);
              }}
            />
          </box>
        )}

        {phase === "connectlocal" && <text fg={T.dim}>{`Connecting to ${describeLocal(local)}...`}</text>}

        {phase === "typetarget" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.fg}>{`Pull "${sourceDb}" from ${parsePgUrl(source!.url).host}`}</text>
            <text fg={T.dim}>Local database name (enter = same name):</text>
            <box style={{ border: true, borderStyle: "single", borderColor: T.border, height: 3, width: 50, paddingLeft: 1 }}>
              <input placeholder={sourceDb} focused onInput={setTargetName} onSubmit={(v) => submitTarget(typeof v === "string" ? v : "")} />
            </box>
            <text fg={T.dim}>
              {localDbs.some((d) => d.name === (targetName.trim() || sourceDb))
                ? `"${targetName.trim() || sourceDb}" exists locally — you'll confirm the overwrite next`
                : `creates a new local database`}
            </text>
          </box>
        )}

        {phase === "confirm" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.red}>{`⚠ This DROPS local database "${targetName}" and replaces it with ${sourceDb}.`}</text>
            <text fg={T.dim}>Type the database name to confirm:</text>
            <box
              style={{
                border: true,
                borderStyle: "single",
                borderColor: confirmText === targetName ? T.green : T.border,
                height: 3,
                width: 50,
                paddingLeft: 1,
              }}
            >
              <input
                placeholder={targetName}
                focused
                onInput={setConfirmText}
                onSubmit={(v) => v === targetName && runPull(targetName, "overwrite")}
              />
            </box>
            <text fg={confirmText === targetName ? T.green : T.dim}>
              {confirmText === targetName ? "✓ press enter to pull" : "names don't match yet"}
            </text>
          </box>
        )}

        {(phase === "running" || phase === "done" || phase === "error") && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            {events.map((e, i) => {
              const isLast = i === events.length - 1;
              const color =
                e.step === "error" ? T.red : e.step === "done" ? T.green : isLast && phase === "running" ? T.yellow : T.dim;
              const prefix = phase === "running" && isLast ? SPINNER_FRAMES[frame] : e.step === "error" ? "✗" : "✓";
              return <text key={i} fg={color}>{`${prefix} ${e.detail}`}</text>;
            })}
            {phase === "running" && current?.pct !== undefined && <ProgressBar pct={current.pct} width={44} color={T.cyan} />}
            {phase === "done" && result && (
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                <text fg={T.green}>{`  Local database "${result.database}" is ready`}</text>
                <text fg={T.fg}>{`  ${result.url.replace(/:[^:@/]+@/, ":****@")}`}</text>
                {result.warnings.length > 0 && (
                  <text fg={T.yellow}>{`  ${result.warnings.length} warning(s) — usually harmless ownership notices`}</text>
                )}
              </box>
            )}
            {phase === "error" && <text fg={T.red}>{errorText.slice(0, 500)}</text>}
          </box>
        )}
      </box>
      <Footer
        hints={
          phase === "running"
            ? [["esc", "cancel"]]
            : phase === "confirm"
              ? [
                  ["type name", "confirm"],
                  ["enter", "pull"],
                  ["esc", "back"],
                ]
              : phase === "typetarget"
                ? [
                    ["type", "name"],
                    ["enter", "pull"],
                    ["esc", "back"],
                  ]
                : phase === "done" || phase === "error"
                  ? [["enter/esc", "back"]]
                  : [
                      ["↑↓", "select"],
                      ["enter", "choose"],
                      ["esc", "back"],
                    ]
        }
      />
    </box>
  );
}
