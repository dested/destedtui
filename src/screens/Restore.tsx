import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ListPicker, type ListItem } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import type { DatabaseInfo, Discovery } from "../lib/discovery.ts";
import { parsePgUrl, withDatabase } from "../lib/pgurl.ts";
import { fmtBytes, msg } from "../lib/pgtools.ts";
import {
  listBackupZips,
  newDbName,
  startRestore,
  type BackupZipInfo,
  type RestoreEvent,
  type RestoreJob,
  type RestoreMode,
  type RestoreResult,
  type RestoreSourceRef,
  type RestoreTargetRef,
} from "../lib/restore.ts";
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
  /** When set, the target DB is fixed (e.g. launched from the Local Postgres browser). */
  preset?: { url: string; mode: RestoreMode; label: string };
}

type Phase =
  | "pickproject"
  | "pickzip"
  | "pickfile"
  | "picktarget"
  | "connectlocal"
  | "picklocaldb"
  | "typenew"
  | "pickmode"
  | "confirm"
  | "running"
  | "done"
  | "error";

const FILE_SOURCE_ID = "__file__";
const NEW_LOCAL_ID = "__newlocal__";

export function Restore({ discovery, back, preset }: Props) {
  const hasProjects = discovery.databases.length > 0;
  const [phase, setPhase] = useState<Phase>(hasProjects ? "pickproject" : "pickfile");
  const [local] = useState<LocalConn>(() => loadLocalConn());

  // source selection
  const [source, setSource] = useState<RestoreSourceRef | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [originUrl, setOriginUrl] = useState<string | null>(null); // set only for project-zip sources
  const [project, setProject] = useState<DatabaseInfo | null>(null);
  const [zips, setZips] = useState<BackupZipInfo[]>([]);
  const [filePath, setFilePath] = useState("");

  // target selection
  const [localDbs, setLocalDbs] = useState<LocalDbInfo[]>([]);
  const [target, setTarget] = useState<RestoreTargetRef | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [confirmReturn, setConfirmReturn] = useState<Phase>("pickproject");
  const [newName, setNewName] = useState("");

  // run state
  const [events, setEvents] = useState<RestoreEvent[]>([]);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [errorText, setErrorText] = useState("");
  const [localErr, setLocalErr] = useState("");
  const [frame, setFrame] = useState(0);
  const jobRef = useRef<RestoreJob | null>(null);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, [phase]);

  // ---- source pickers -------------------------------------------------------

  const pickProject = (picked: DatabaseInfo) => {
    setProject(picked);
    setPhase("pickzip");
    listBackupZips(picked.dir).then(setZips);
  };

  const chooseZip = (zip: BackupZipInfo) => {
    const src: RestoreSourceRef = { path: zip.path, metadata: zip.metadata };
    setSource(src);
    setSourceLabel(zip.name);
    setOriginUrl(project ? project.url : null);
    advanceToTarget(src, project ? project.url : null);
  };

  const chooseFile = (raw: string) => {
    const path = raw.trim().replace(/^["']|["']$/g, "");
    if (!path) return;
    const src: RestoreSourceRef = { path };
    setSource(src);
    setSourceLabel(path.split(/[/\\]/).pop() ?? path);
    setOriginUrl(null);
    advanceToTarget(src, null);
  };

  // ---- target routing -------------------------------------------------------

  const advanceToTarget = (src: RestoreSourceRef, origin: string | null) => {
    if (preset) {
      const conn = parsePgUrl(preset.url);
      const tgt: RestoreTargetRef = { conn, mode: preset.mode };
      setTarget(tgt);
      if (preset.mode === "overwrite") {
        setConfirmText("");
        setConfirmReturn(hasProjects ? "pickproject" : "pickfile");
        setPhase("confirm");
      } else {
        runInto(src, tgt);
      }
      return;
    }
    if (origin) {
      setPhase("picktarget");
    } else {
      beginLocalhost();
    }
  };

  const beginLocalhost = () => {
    setPhase("connectlocal");
    setLocalErr("");
    listLocalDatabases(localPgConn(local))
      .then((dbs) => {
        setLocalDbs(dbs);
        setPhase("picklocaldb");
      })
      .catch((err) => {
        setLocalErr(msg(err));
        setPhase("error");
        setErrorText(
          `Couldn't reach local Postgres at ${describeLocal(local)}\n${msg(err)}\n\nFix the connection in the "Local Postgres" screen (menu), then try again.`,
        );
      });
  };

  const chooseLocalExisting = (name: string) => {
    const tgt: RestoreTargetRef = { conn: localPgConn(local, name), mode: "overwrite" };
    setTarget(tgt);
    setConfirmText("");
    setConfirmReturn("picklocaldb");
    setPhase("confirm");
  };

  const chooseOriginMode = (mode: RestoreMode) => {
    if (!originUrl) return;
    const origin = parsePgUrl(originUrl);
    if (mode === "new") {
      const tgt: RestoreTargetRef = { conn: withDatabase(origin, newDbName(origin.database)), mode: "new" };
      setTarget(tgt);
      if (source) runInto(source, tgt);
    } else {
      const tgt: RestoreTargetRef = { conn: origin, mode: "overwrite" };
      setTarget(tgt);
      setConfirmText("");
      setConfirmReturn("pickmode");
      setPhase("confirm");
    }
  };

  // ---- run ------------------------------------------------------------------

  const runInto = (src: RestoreSourceRef, tgt: RestoreTargetRef) => {
    setEvents([]);
    setPhase("running");
    const job = startRestore(src, tgt, (e) => {
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

  // ---- keyboard / back ------------------------------------------------------

  useKeyboard((key) => {
    if (key.name === "return" && (phase === "done" || phase === "error")) {
      back();
      return;
    }
    if (key.name !== "escape") return;
    switch (phase) {
      case "running":
        jobRef.current?.cancel();
        setPhase(hasProjects ? "pickproject" : "pickfile");
        break;
      case "pickzip":
        setPhase("pickproject");
        break;
      case "pickfile":
        if (hasProjects) setPhase("pickproject");
        else back();
        break;
      case "picktarget":
        setPhase(originUrl ? "pickzip" : "pickfile");
        break;
      case "connectlocal":
      case "picklocaldb":
        setPhase(preset ? (hasProjects ? "pickproject" : "pickfile") : "picktarget");
        break;
      case "typenew":
        setNewName("");
        setPhase("picklocaldb");
        break;
      case "pickmode":
        setPhase("picktarget");
        break;
      case "confirm":
        setConfirmText("");
        setPhase(confirmReturn);
        break;
      default:
        back();
    }
  });

  const current = events[events.length - 1];
  const confirmName = target?.conn.database ?? "";

  // ---- project + file source list ------------------------------------------
  const projectItems: ListItem[] = [
    ...discovery.databases.map((d, i) => ({
      id: `${d.envPath}-${i}`,
      icon: "⛁",
      title: d.rel === "." ? "(this directory)" : d.rel,
      subtitle: d.redacted.slice(0, 60),
      badge: d.key,
      badgeColor: T.purple,
    })),
    {
      id: FILE_SOURCE_ID,
      icon: "⇪",
      title: "Restore from a file…",
      subtitle: "point at any .zip / .dump / .sql on disk",
      badge: "file",
      badgeColor: T.cyan,
    },
  ];

  const localItems: ListItem[] = [
    {
      id: NEW_LOCAL_ID,
      icon: "＋",
      title: "Create a new database",
      subtitle: "restore into a fresh DB you name",
      badge: "new",
      badgeColor: T.green,
    },
    ...localDbs.map((d) => ({
      id: d.name,
      icon: "⛁",
      title: d.name,
      subtitle: `${d.owner} · ${d.encoding}`,
      badge: fmtBytes(d.sizeBytes),
      badgeColor: T.dim,
    })),
  ];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title={preset ? ` restore → ${preset.label} ` : " pg restore "}
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
        {phase === "pickproject" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>Where's the dump coming from?</text>
            <ListPicker
              vimKeys
              items={projectItems}
              onSelect={(item, index) => {
                if (item.id === FILE_SOURCE_ID) setPhase("pickfile");
                else {
                  const picked = discovery.databases[index];
                  if (picked) pickProject(picked);
                }
              }}
            />
          </box>
        )}

        {phase === "pickzip" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>{`Backups in ${project?.rel === "." ? "this directory" : project?.rel}`}</text>
            <ListPicker
              vimKeys
              emptyText="No pgbackup-*.zip here — run a backup, or esc and pick 'Restore from a file…'"
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
                if (chosen) chooseZip(chosen);
              }}
            />
          </box>
        )}

        {phase === "pickfile" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>Path to a backup file (.zip, .dump, .backup, or .sql):</text>
            <box style={{ border: true, borderStyle: "single", borderColor: T.border, height: 3, paddingLeft: 1 }}>
              <input
                placeholder="C:\path\to\backup.dump"
                focused
                onInput={setFilePath}
                onSubmit={(v) => chooseFile(typeof v === "string" ? v : "")}
              />
            </box>
            <text fg={T.dim}>{filePath.trim() ? "press enter to continue → restores into localhost" : "enter a path"}</text>
          </box>
        )}

        {phase === "picktarget" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.fg}>{sourceLabel}</text>
            <text fg={T.dim}>Restore it where?</text>
            <ListPicker
              vimKeys
              items={[
                {
                  id: "original",
                  icon: "⟳",
                  title: "Original server",
                  subtitle: originUrl ? parsePgUrl(originUrl).host : "",
                  badge: "from .env",
                  badgeColor: T.purple,
                },
                {
                  id: "local",
                  icon: "🖳",
                  title: "Localhost Postgres",
                  subtitle: describeLocal(local),
                  badge: "existing or new",
                  badgeColor: T.cyan,
                },
              ]}
              onSelect={(item) => {
                if (item.id === "original") setPhase("pickmode");
                else beginLocalhost();
              }}
            />
          </box>
        )}

        {phase === "connectlocal" && <text fg={T.dim}>{`Connecting to ${describeLocal(local)}...`}</text>}

        {phase === "picklocaldb" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>{`Restore ${sourceLabel} into which local database?`}</text>
            <ListPicker
              vimKeys
              visible={13}
              items={localItems}
              onSelect={(item) => {
                if (item.id === NEW_LOCAL_ID) {
                  setNewName("");
                  setPhase("typenew");
                } else {
                  chooseLocalExisting(item.id);
                }
              }}
            />
          </box>
        )}

        {phase === "typenew" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>Name for the new local database:</text>
            <box
              style={{
                border: true,
                borderStyle: "single",
                borderColor: newNameValid(newName, localDbs) ? T.green : T.border,
                height: 3,
                width: 50,
                paddingLeft: 1,
              }}
            >
              <input
                placeholder="my_local_db"
                focused
                onInput={setNewName}
                onSubmit={(v) => {
                  const name = typeof v === "string" ? v : "";
                  if (newNameValid(name, localDbs) && source) {
                    runInto(source, { conn: localPgConn(local, name.trim()), mode: "new" });
                  }
                }}
              />
            </box>
            <text fg={newNameValid(newName, localDbs) ? T.green : T.dim}>
              {newNameStatus(newName, localDbs)}
            </text>
          </box>
        )}

        {phase === "pickmode" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.fg}>{sourceLabel}</text>
            <text fg={T.dim}>How should it be restored on the original server?</text>
            <ListPicker
              vimKeys
              items={[
                {
                  id: "new",
                  icon: "＋",
                  title: "Restore to a NEW database",
                  subtitle: originUrl ? `safe — creates ${parsePgUrl(originUrl).database}_restored_<timestamp>` : "",
                  badge: "safe",
                  badgeColor: T.green,
                },
                {
                  id: "overwrite",
                  icon: "⚠",
                  title: originUrl ? `Overwrite "${parsePgUrl(originUrl).database}"` : "Overwrite",
                  subtitle: "drops and recreates the database from the backup",
                  badge: "destructive",
                  badgeColor: T.red,
                },
              ]}
              onSelect={(item) => chooseOriginMode(item.id as RestoreMode)}
            />
          </box>
        )}

        {phase === "confirm" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.red}>{`⚠ This DROPS database "${confirmName}" on ${target?.conn.host} and replaces it.`}</text>
            <text fg={T.dim}>Type the database name to confirm:</text>
            <box
              style={{
                border: true,
                borderStyle: "single",
                borderColor: confirmText === confirmName ? T.green : T.border,
                height: 3,
                width: 50,
                paddingLeft: 1,
              }}
            >
              <input
                placeholder={confirmName}
                focused
                onInput={setConfirmText}
                onSubmit={(v) => v === confirmName && source && target && runInto(source, target)}
              />
            </box>
            <text fg={confirmText === confirmName ? T.green : T.dim}>
              {confirmText === confirmName ? "✓ press enter to restore" : "names don't match yet"}
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
                  ["enter", "restore"],
                  ["esc", "back"],
                ]
              : phase === "typenew" || phase === "pickfile"
                ? [
                    ["type", "value"],
                    ["enter", "continue"],
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

function newNameValid(name: string, existing: LocalDbInfo[]): boolean {
  const n = name.trim();
  return n.length > 0 && !existing.some((d) => d.name === n);
}

function newNameStatus(name: string, existing: LocalDbInfo[]): string {
  const n = name.trim();
  if (!n) return "enter a name";
  if (existing.some((d) => d.name === n)) return `"${n}" already exists — pick it from the list to overwrite`;
  return "✓ press enter to create & restore";
}
