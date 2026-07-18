import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ListPicker } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import type { DatabaseInfo, Discovery } from "../lib/discovery.ts";
import { parsePgUrl } from "../lib/pgurl.ts";
import { fmtBytes } from "../lib/pgtools.ts";
import {
  listBackupZips,
  startRestore,
  type BackupZipInfo,
  type RestoreEvent,
  type RestoreJob,
  type RestoreMode,
  type RestoreResult,
} from "../lib/restore.ts";

interface Props {
  discovery: Discovery;
  back: () => void;
}

type Phase = "pickdb" | "loadzips" | "pickzip" | "pickmode" | "confirm" | "running" | "done" | "error";

export function Restore({ discovery, back }: Props) {
  const [phase, setPhase] = useState<Phase>("pickdb");
  const [db, setDb] = useState<DatabaseInfo | null>(null);
  const [zips, setZips] = useState<BackupZipInfo[]>([]);
  const [zip, setZip] = useState<BackupZipInfo | null>(null);
  const [mode, setMode] = useState<RestoreMode>("new");
  const [confirmText, setConfirmText] = useState("");
  const [events, setEvents] = useState<RestoreEvent[]>([]);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [errorText, setErrorText] = useState("");
  const [frame, setFrame] = useState(0);
  const jobRef = useRef<RestoreJob | null>(null);

  const dbName = db ? parsePgUrl(db.url).database : "";

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, [phase]);

  const pickDb = (picked: DatabaseInfo) => {
    setDb(picked);
    setPhase("loadzips");
    listBackupZips(picked.dir).then((found) => {
      setZips(found);
      setPhase("pickzip");
    });
  };

  const run = (chosenMode: RestoreMode) => {
    if (!db || !zip) return;
    setEvents([]);
    setPhase("running");
    const job = startRestore(db, zip, chosenMode, (e) => {
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
    if (key.name === "escape") {
      if (phase === "running") {
        jobRef.current?.cancel();
        setPhase("pickmode");
      } else if (phase === "pickzip" || phase === "loadzips") {
        setPhase("pickdb");
      } else if (phase === "pickmode") {
        setPhase("pickzip");
      } else if (phase === "confirm") {
        setConfirmText("");
        setPhase("pickmode");
      } else {
        back();
      }
    } else if (key.name === "return") {
      if (phase === "done" || phase === "error") back();
    }
  });

  const current = events[events.length - 1];
  const meta = zip?.metadata;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" pg restore "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: phase === "done" ? T.green : phase === "error" ? T.red : T.border,
          titleColor: T.orange,
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
            <text fg={T.dim}>Which project's database?</text>
            <ListPicker
              vimKeys
              items={discovery.databases.map((d, i) => ({
                id: `${d.envPath}-${i}`,
                icon: "⛁",
                title: d.rel === "." ? "(this directory)" : d.rel,
                subtitle: d.redacted.slice(0, 70),
                badge: d.key,
                badgeColor: T.purple,
              }))}
              onSelect={(_item, index) => {
                const picked = discovery.databases[index];
                if (picked) pickDb(picked);
              }}
            />
          </box>
        )}

        {phase === "loadzips" && <text fg={T.dim}>Scanning for backup zips...</text>}

        {phase === "pickzip" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>{`Backups in ${db?.rel === "." ? "this directory" : db?.rel}`}</text>
            <ListPicker
              vimKeys
              emptyText="No pgbackup-*.zip files here — run a backup first"
              items={zips.map((z, i) => ({
                id: `${z.path}-${i}`,
                icon: "◈",
                title: z.name,
                subtitle: `${fmtBytes(z.bytes)} · ${typeof z.metadata?.serverVersion === "string" ? `pg ${z.metadata.serverVersion}` : "unknown version"}`,
                badge: z.mtime.toLocaleString(),
                badgeColor: T.dim,
              }))}
              onSelect={(_item, index) => {
                const chosen = zips[index];
                if (chosen) {
                  setZip(chosen);
                  setPhase("pickmode");
                }
              }}
            />
          </box>
        )}

        {phase === "pickmode" && zip && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.fg}>{zip.name}</text>
            {meta && (
              <text fg={T.dim}>{`  ${String(meta.database ?? "?")} · pg ${String(meta.serverVersion ?? "?")} · dumped ${String(meta.createdAt ?? "?")}`}</text>
            )}
            <text fg={T.dim}>How should it be restored?</text>
            <ListPicker
              vimKeys
              items={[
                {
                  id: "new",
                  icon: "＋",
                  title: "Restore to a NEW database",
                  subtitle: `safe — creates ${dbName}_restored_<timestamp>, original untouched`,
                  badge: "safe",
                  badgeColor: T.green,
                },
                {
                  id: "overwrite",
                  icon: "⚠",
                  title: `Overwrite "${dbName}"`,
                  subtitle: "drops and recreates the database from the backup",
                  badge: "destructive",
                  badgeColor: T.red,
                },
              ]}
              onSelect={(item) => {
                if (item.id === "new") {
                  setMode("new");
                  run("new");
                } else {
                  setMode("overwrite");
                  setConfirmText("");
                  setPhase("confirm");
                }
              }}
            />
          </box>
        )}

        {phase === "confirm" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.red}>{`⚠ This DROPS database "${dbName}" and replaces it with the backup.`}</text>
            <text fg={T.dim}>{`Type the database name to confirm:`}</text>
            <box style={{ border: true, borderStyle: "single", borderColor: confirmText === dbName ? T.green : T.border, height: 3, width: 50, paddingLeft: 1 }}>
              <input placeholder={dbName} focused onInput={setConfirmText} onSubmit={(v) => v === dbName && run("overwrite")} />
            </box>
            <text fg={confirmText === dbName ? T.green : T.dim}>
              {confirmText === dbName ? "✓ press enter to restore" : "names don't match yet"}
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
            {phase === "running" && current?.pct !== undefined && <ProgressBar pct={current.pct} width={44} color={T.orange} />}
            {phase === "done" && result && (
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                <text fg={T.green}>{`  Restored into "${result.database}"`}</text>
                {mode === "new" && <text fg={T.fg}>{`  ${result.url.replace(/:[^:@/]+@/, ":****@")}`}</text>}
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
                  ["enter", "restore"],
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
