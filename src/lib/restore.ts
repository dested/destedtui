import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseInfo } from "./discovery.ts";
import { parsePgUrl, withDatabase, type PgConn } from "./pgurl.ts";
import { adminQuery, detectServer, ensureTools, fmtBytes, msg, type ToolProgress } from "./pgtools.ts";
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

export type RestoreMode = "overwrite" | "new";

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

export function startRestore(
  db: DatabaseInfo,
  zip: BackupZipInfo,
  mode: RestoreMode,
  onEvent: (e: RestoreEvent) => void,
): RestoreJob {
  let cancelled = false;
  let activeProc: ProcHandle | null = null;

  const cancel = () => {
    cancelled = true;
    activeProc?.kill();
  };

  const result = (async (): Promise<RestoreResult> => {
    const source = parsePgUrl(db.url);
    const tmpDump = join(db.dir, `.pgrestore-${process.pid}.dump.tmp`);
    try {
      onEvent({ step: "connect", detail: `Connecting to ${source.host}:${source.port}...` });
      const server = await detectServer(source);
      if (cancelled) throw new Error("Cancelled");
      onEvent({ step: "connect", detail: `PostgreSQL ${server.version} at ${source.host}:${source.port}` });

      const dumpMajor = typeof zip.metadata?.serverMajor === "string" ? (zip.metadata.serverMajor as string) : null;
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

      onEvent({ step: "extract", detail: "Extracting dump from zip..." });
      const entry = await extractZipEntry(
        zip.path,
        (name) => name.endsWith(".dump"),
        tmpDump,
        (bytes) => onEvent({ step: "extract", detail: `Extracting... ${fmtBytes(bytes)}` }),
      );
      if (!entry) throw new Error("No .dump entry found inside this zip — is it a destedtui backup?");
      if (cancelled) throw new Error("Cancelled");

      const target: PgConn =
        mode === "overwrite" ? source : withDatabase(source, newDbName(source.database));

      if (mode === "overwrite") {
        onEvent({ step: "prepare", detail: `Dropping and recreating "${target.database}"...` });
        await adminQuery(source, server.ssl, [
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${target.database.replace(/'/g, "''")}' AND pid <> pg_backend_pid()`,
          `DROP DATABASE IF EXISTS ${quoteIdent(target.database)}`,
          `CREATE DATABASE ${quoteIdent(target.database)}`,
        ]);
      } else {
        onEvent({ step: "prepare", detail: `Creating database "${target.database}"...` });
        await adminQuery(source, server.ssl, [`CREATE DATABASE ${quoteIdent(target.database)}`]);
      }
      if (cancelled) throw new Error("Cancelled");

      onEvent({ step: "restore", detail: `Restoring into "${target.database}"...` });
      const args = [
        tools.pgRestore,
        "--no-owner",
        "--no-acl",
        `--role=${source.user}`,
        `--host=${source.host}`,
        `--port=${String(source.port)}`,
        `--username=${source.user}`,
        "--no-password",
        `--dbname=${target.database}`,
        tmpDump,
      ];
      const env: Record<string, string> = { PGPASSWORD: source.password };
      if (server.ssl) env.PGSSLMODE = "require";

      let lastLine = "";
      const { handle, result: toolResult } = runTool(args, env, (line) => {
        lastLine = line;
        onEvent({ step: "restore", detail: line.slice(0, 120) });
      });
      activeProc = handle;
      const { code, stderrTail } = await toolResult;
      activeProc = null;
      if (cancelled) throw new Error("Cancelled");

      const warnings = stderrTail.filter((l) => /warning|error/i.test(l));
      if (code !== 0) {
        // pg_restore exits non-zero even for ignorable errors; the DB usually restored fine.
        onEvent({
          step: "done",
          detail: `Restore finished with warnings (exit ${code}). Database: "${target.database}"`,
        });
        return { database: target.database, url: target.url, warnings: stderrTail.slice(-15) };
      }
      onEvent({ step: "done", detail: `Restore complete: "${target.database}"` });
      return { database: target.database, url: target.url, warnings };
    } catch (err) {
      onEvent({ step: "error", detail: cancelled ? "Restore cancelled" : msg(err) });
      throw err;
    } finally {
      try {
        if (existsSync(tmpDump)) unlinkSync(tmpDump);
      } catch {
        /* leave temp file if locked */
      }
    }
  })();

  return { result, cancel };
}
