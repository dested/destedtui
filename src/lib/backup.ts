import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseInfo } from "./discovery.ts";
import { parsePgUrl } from "./pgurl.ts";
import { detectServer, ensureTools, fmtBytes, msg, type ToolProgress } from "./pgtools.ts";
import { runTool, type ProcHandle } from "./run.ts";
import { createBackupZip } from "./zip.ts";

export interface BackupEvent {
  step: "connect" | "tools" | "dump" | "zip" | "done" | "error";
  detail: string;
  pct?: number;
}

export interface BackupResult {
  zipPath: string;
  zipBytes: number;
  database: string;
  serverVersion: string;
}

export interface BackupJob {
  result: Promise<BackupResult>;
  cancel: () => void;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function startBackup(db: DatabaseInfo, onEvent: (e: BackupEvent) => void): BackupJob {
  let cancelled = false;
  let activeProc: ProcHandle | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const cancel = () => {
    cancelled = true;
    activeProc?.kill();
  };

  const result = (async (): Promise<BackupResult> => {
    const conn = parsePgUrl(db.url);
    const tmpDump = join(db.dir, `.pgbackup-${process.pid}.dump.tmp`);
    try {
      onEvent({ step: "connect", detail: `Connecting to ${conn.host}:${conn.port}/${conn.database}...` });
      const server = await detectServer(conn);
      if (cancelled) throw new Error("Cancelled");
      onEvent({ step: "connect", detail: `PostgreSQL ${server.version} — database "${conn.database}"` });

      const tools = await ensureTools(server.major, (p: ToolProgress) =>
        onEvent({ step: "tools", detail: p.detail, pct: p.pct }),
      );
      if (cancelled) throw new Error("Cancelled");

      onEvent({ step: "dump", detail: "Starting pg_dump..." });
      const args = [
        tools.pgDump,
        "--format=custom",
        `--file=${tmpDump}`,
        `--host=${conn.host}`,
        `--port=${String(conn.port)}`,
        `--username=${conn.user}`,
        "--no-password",
        conn.database,
      ];
      const env: Record<string, string> = { PGPASSWORD: conn.password };
      if (server.ssl) env.PGSSLMODE = "require";

      const { handle, result: toolResult } = runTool(args, env);
      activeProc = handle;
      pollTimer = setInterval(() => {
        try {
          if (existsSync(tmpDump)) {
            onEvent({ step: "dump", detail: `Dumping... ${fmtBytes(statSync(tmpDump).size)}` });
          }
        } catch {
          /* file may vanish between calls */
        }
      }, 300);

      const { code, stderrTail } = await toolResult;
      if (pollTimer) clearInterval(pollTimer);
      activeProc = null;
      if (cancelled) throw new Error("Cancelled");
      if (code !== 0) {
        throw new Error(`pg_dump exited with code ${code}:\n${stderrTail.slice(-8).join("\n")}`);
      }
      const dumpBytes = statSync(tmpDump).size;
      onEvent({ step: "dump", detail: `Dump complete (${fmtBytes(dumpBytes)})` });

      const zipName = `pgbackup-${sanitize(conn.database)}-${timestamp()}.zip`;
      const zipPath = join(db.dir, zipName);
      onEvent({ step: "zip", detail: `Zipping to ${zipName}...` });
      await createBackupZip(
        zipPath,
        tmpDump,
        `${sanitize(conn.database)}.dump`,
        {
          tool: "destedtui",
          format: "pg_dump custom",
          database: conn.database,
          host: conn.host,
          port: conn.port,
          serverVersion: server.version,
          serverMajor: server.major,
          dumpedWith: `${tools.source}:${tools.toolMajor}`,
          envKey: db.key,
          createdAt: new Date().toISOString(),
          dumpBytes,
        },
        (bytes) => onEvent({ step: "zip", detail: `Zipping... ${fmtBytes(bytes)}`, pct: Math.min(bytes / dumpBytes, 1) }),
      );
      const zipBytes = statSync(zipPath).size;
      onEvent({ step: "done", detail: `Backup written: ${zipPath} (${fmtBytes(zipBytes)})` });
      return { zipPath, zipBytes, database: conn.database, serverVersion: server.version };
    } catch (err) {
      onEvent({ step: "error", detail: cancelled ? "Backup cancelled" : msg(err) });
      throw err;
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      try {
        if (existsSync(tmpDump)) unlinkSync(tmpDump);
      } catch {
        /* leave the temp file if locked */
      }
    }
  })();

  return { result, cancel };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
