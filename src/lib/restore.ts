import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { withDatabase, type PgConn } from "./pgurl.ts";
import { adminQuery, detectServer, ensureTools, fmtBytes, msg, type ServerInfo, type ToolProgress } from "./pgtools.ts";
import { runTool, type ProcHandle } from "./run.ts";
import { extractZipEntry, readZipMetadata } from "./zip.ts";

export interface BackupZipInfo {
  path: string;
  name: string;
  bytes: number;
  mtime: Date;
  metadata: Record<string, unknown> | null;
}

/** List pgbackup-*.zip files in a project dir, newest first, with metadata. */
export async function listBackupZips(dir: string): Promise<BackupZipInfo[]> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const zips = entries.filter((e) => e.startsWith("pgbackup-") && e.endsWith(".zip"));
  const out: BackupZipInfo[] = [];
  for (const name of zips) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      const metadata = await readZipMetadata(path);
      out.push({ path, name, bytes: st.size, mtime: st.mtime, metadata });
    } catch {
      /* skip unreadable zip */
    }
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

/** "overwrite" = drop + recreate the target DB, "new" = CREATE a fresh (must-not-exist) DB. */
export type RestoreMode = "overwrite" | "new";

/** Where the dump comes from: a destedtui/generic .zip, or a raw .dump/.backup/.sql file. */
export interface RestoreSourceRef {
  path: string;
  /** metadata.json contents when the source is a project zip (drives the version-mismatch note) */
  metadata?: Record<string, unknown> | null;
}

/** Where the dump goes: a full connection whose `.database` is the DB to restore into. */
export interface RestoreTargetRef {
  conn: PgConn;
  mode: RestoreMode;
}

export interface RestoreEvent {
  step: "connect" | "tools" | "extract" | "prepare" | "restore" | "done" | "error";
  detail: string;
  pct?: number;
}

export interface RestoreResult {
  /** Database that was restored into */
  database: string;
  /** Connection URL for the restored database */
  url: string;
  warnings: string[];
}

export interface RestoreJob {
  result: Promise<RestoreResult>;
  cancel: () => void;
}

export function newDbName(base: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base}_restored_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** custom-format archive (pg_restore) vs plain SQL (psql). */
function dumpKind(name: string): "custom" | "plain" {
  return /\.sql$/i.test(name) ? "plain" : "custom";
}

/** Detect the server, trying the maintenance DB first so a not-yet-created target still resolves. */
async function detectTarget(conn: PgConn): Promise<ServerInfo> {
  try {
    return await detectServer(withDatabase(conn, "postgres"));
  } catch {
    return detectServer(conn);
  }
}

export function startRestore(
  source: RestoreSourceRef,
  target: RestoreTargetRef,
  onEvent: (e: RestoreEvent) => void,
): RestoreJob {
  let cancelled = false;
  let activeProc: ProcHandle | null = null;

  const cancel = () => {
    cancelled = true;
    activeProc?.kill();
  };

  const result = (async (): Promise<RestoreResult> => {
    const t = target.conn;
    const isZip = source.path.toLowerCase().endsWith(".zip");
    const tmpDump = join(tmpdir(), `.destedtui-restore-${process.pid}.dump.tmp`);
    let extracted = false;
    try {
      onEvent({ step: "connect", detail: `Connecting to ${t.host}:${t.port}...` });
      const server = await detectTarget(t);
      if (cancelled) throw new Error("Cancelled");
      onEvent({ step: "connect", detail: `PostgreSQL ${server.version} at ${t.host}:${t.port}` });

      const dumpMajor = typeof source.metadata?.serverMajor === "string" ? (source.metadata.serverMajor as string) : null;
      if (dumpMajor && dumpMajor !== server.major) {
        onEvent({
          step: "connect",
          detail: `Note: backup came from PostgreSQL ${dumpMajor}, target server is ${server.major}`,
        });
      }

      const tools = await ensureTools(server.major, (p: ToolProgress) =>
        onEvent({ step: "tools", detail: p.detail, pct: p.pct }),
      );
      if (cancelled) throw new Error("Cancelled");

      // Resolve the artifact on disk + its format.
      let artifactPath: string;
      let entryName: string;
      if (isZip) {
        onEvent({ step: "extract", detail: "Extracting dump from zip..." });
        const entry = await extractZipEntry(
          source.path,
          (name) => /\.(dump|backup|sql)$/i.test(name),
          tmpDump,
          (bytes) => onEvent({ step: "extract", detail: `Extracting... ${fmtBytes(bytes)}` }),
        );
        if (!entry) throw new Error("No .dump/.backup/.sql entry found inside this zip.");
        extracted = true;
        artifactPath = tmpDump;
        entryName = entry;
      } else {
        if (!existsSync(source.path)) throw new Error(`File not found: ${source.path}`);
        artifactPath = source.path;
        entryName = basename(source.path);
      }
      const kind = dumpKind(entryName);
      if (cancelled) throw new Error("Cancelled");

      // Create / recreate the target database.
      if (target.mode === "overwrite") {
        onEvent({ step: "prepare", detail: `Dropping and recreating "${t.database}"...` });
        await adminQuery(t, server.ssl, [
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${t.database.replace(/'/g, "''")}' AND pid <> pg_backend_pid()`,
          `DROP DATABASE IF EXISTS ${quoteIdent(t.database)}`,
          `CREATE DATABASE ${quoteIdent(t.database)}`,
        ]);
      } else {
        onEvent({ step: "prepare", detail: `Creating database "${t.database}"...` });
        await adminQuery(t, server.ssl, [`CREATE DATABASE ${quoteIdent(t.database)}`]);
      }
      if (cancelled) throw new Error("Cancelled");

      onEvent({ step: "restore", detail: `Restoring ${kind === "plain" ? "SQL" : "archive"} into "${t.database}"...` });
      const args =
        kind === "plain"
          ? [
              tools.psql,
              `--host=${t.host}`,
              `--port=${String(t.port)}`,
              `--username=${t.user}`,
              "--no-password",
              `--dbname=${t.database}`,
              "--set=ON_ERROR_STOP=0",
              "--quiet",
              "--file",
              artifactPath,
            ]
          : [
              tools.pgRestore,
              "--no-owner",
              "--no-acl",
              `--host=${t.host}`,
              `--port=${String(t.port)}`,
              `--username=${t.user}`,
              "--no-password",
              `--dbname=${t.database}`,
              artifactPath,
            ];
      const env: Record<string, string> = { PGPASSWORD: t.password };
      if (server.ssl) env.PGSSLMODE = "require";

      const { handle, result: toolResult } = runTool(args, env, (line) => {
        onEvent({ step: "restore", detail: line.slice(0, 120) });
      });
      activeProc = handle;
      const { code, stderrTail } = await toolResult;
      activeProc = null;
      if (cancelled) throw new Error("Cancelled");

      const warnings = stderrTail.filter((l) => /warning|error/i.test(l));
      if (code !== 0) {
        // pg_restore/psql exit non-zero even for ignorable errors; the DB usually restored fine.
        onEvent({
          step: "done",
          detail: `Restore finished with warnings (exit ${code}). Database: "${t.database}"`,
        });
        return { database: t.database, url: t.url, warnings: stderrTail.slice(-15) };
      }
      onEvent({ step: "done", detail: `Restore complete: "${t.database}"` });
      return { database: t.database, url: t.url, warnings };
    } catch (err) {
      onEvent({ step: "error", detail: cancelled ? "Restore cancelled" : msg(err) });
      throw err;
    } finally {
      if (extracted) {
        try {
          if (existsSync(tmpDump)) unlinkSync(tmpDump);
        } catch {
          /* leave temp file if locked */
        }
      }
    }
  })();

  return { result, cancel };
}
