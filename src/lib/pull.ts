import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePgUrl, withDatabase } from "./pgurl.ts";
import { adminQuery, detectServer, ensureTools, fmtBytes, msg, type ToolProgress } from "./pgtools.ts";
import { runTool, type ProcHandle } from "./run.ts";
import type { RestoreTargetRef } from "./restore.ts";

export interface PullEvent {
  step: "connect" | "tools" | "dump" | "prepare" | "restore" | "done" | "error";
  detail: string;
  pct?: number;
}

export interface PullResult {
  database: string;
  url: string;
  warnings: string[];
}

export interface PullJob {
  result: Promise<PullResult>;
  cancel: () => void;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Dump a source database and restore it straight into a target (localhost) DB —
 * no intermediate zip. Source is dumped with source-major tools; the restore
 * uses target-major tools so cross-version pulls still work.
 */
export function startPull(
  sourceUrl: string,
  target: RestoreTargetRef,
  onEvent: (e: PullEvent) => void,
): PullJob {
  let cancelled = false;
  let activeProc: ProcHandle | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const cancel = () => {
    cancelled = true;
    activeProc?.kill();
  };

  const result = (async (): Promise<PullResult> => {
    const src = parsePgUrl(sourceUrl);
    const t = target.conn;
    const tmpDump = join(tmpdir(), `.destedtui-pull-${process.pid}.dump.tmp`);
    try {
      onEvent({ step: "connect", detail: `Source: ${src.host}:${src.port}/${src.database}...` });
      const srcServer = await detectServer(src);
      if (cancelled) throw new Error("Cancelled");
      onEvent({ step: "connect", detail: `Source is PostgreSQL ${srcServer.version} — "${src.database}"` });

      onEvent({ step: "connect", detail: `Target: ${t.host}:${t.port}...` });
      let tgtServer;
      try {
        tgtServer = await detectServer(withDatabase(t, "postgres"));
      } catch {
        tgtServer = await detectServer(t);
      }
      if (cancelled) throw new Error("Cancelled");
      onEvent({ step: "connect", detail: `Target is PostgreSQL ${tgtServer.version} at ${t.host}:${t.port}` });

      const dumpTools = await ensureTools(srcServer.major, (p: ToolProgress) =>
        onEvent({ step: "tools", detail: p.detail, pct: p.pct }),
      );
      const restoreTools =
        tgtServer.major === srcServer.major
          ? dumpTools
          : await ensureTools(tgtServer.major, (p: ToolProgress) => onEvent({ step: "tools", detail: p.detail, pct: p.pct }));
      if (cancelled) throw new Error("Cancelled");

      // Dump the source to a temp custom-format archive.
      onEvent({ step: "dump", detail: `Dumping "${src.database}"...` });
      const dumpArgs = [
        dumpTools.pgDump,
        "--format=custom",
        `--file=${tmpDump}`,
        `--host=${src.host}`,
        `--port=${String(src.port)}`,
        `--username=${src.user}`,
        "--no-password",
        src.database,
      ];
      const dumpEnv: Record<string, string> = { PGPASSWORD: src.password };
      if (srcServer.ssl) dumpEnv.PGSSLMODE = "require";
      {
        const { handle, result: toolResult } = runTool(dumpArgs, dumpEnv);
        activeProc = handle;
        pollTimer = setInterval(() => {
          try {
            if (existsSync(tmpDump)) onEvent({ step: "dump", detail: `Dumping... ${fmtBytes(statSync(tmpDump).size)}` });
          } catch {
            /* file may vanish between polls */
          }
        }, 300);
        const { code, stderrTail } = await toolResult;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        activeProc = null;
        if (cancelled) throw new Error("Cancelled");
        if (code !== 0) throw new Error(`pg_dump exited ${code}:\n${stderrTail.slice(-8).join("\n")}`);
      }
      const dumpBytes = statSync(tmpDump).size;
      onEvent({ step: "dump", detail: `Dump complete (${fmtBytes(dumpBytes)})` });

      // Prepare the target DB.
      if (target.mode === "overwrite") {
        onEvent({ step: "prepare", detail: `Dropping and recreating "${t.database}"...` });
        await adminQuery(t, tgtServer.ssl, [
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${t.database.replace(/'/g, "''")}' AND pid <> pg_backend_pid()`,
          `DROP DATABASE IF EXISTS ${quoteIdent(t.database)}`,
          `CREATE DATABASE ${quoteIdent(t.database)}`,
        ]);
      } else {
        onEvent({ step: "prepare", detail: `Creating database "${t.database}"...` });
        await adminQuery(t, tgtServer.ssl, [`CREATE DATABASE ${quoteIdent(t.database)}`]);
      }
      if (cancelled) throw new Error("Cancelled");

      onEvent({ step: "restore", detail: `Restoring into "${t.database}"...` });
      const restoreArgs = [
        restoreTools.pgRestore,
        "--no-owner",
        "--no-acl",
        `--host=${t.host}`,
        `--port=${String(t.port)}`,
        `--username=${t.user}`,
        "--no-password",
        `--dbname=${t.database}`,
        tmpDump,
      ];
      const restoreEnv: Record<string, string> = { PGPASSWORD: t.password };
      if (tgtServer.ssl) restoreEnv.PGSSLMODE = "require";
      const { handle, result: toolResult } = runTool(restoreArgs, restoreEnv, (line) => {
        onEvent({ step: "restore", detail: line.slice(0, 120) });
      });
      activeProc = handle;
      const { code, stderrTail } = await toolResult;
      activeProc = null;
      if (cancelled) throw new Error("Cancelled");

      const warnings = stderrTail.filter((l) => /warning|error/i.test(l));
      if (code !== 0) {
        onEvent({ step: "done", detail: `Pull finished with warnings (exit ${code}). Database: "${t.database}"` });
        return { database: t.database, url: t.url, warnings: stderrTail.slice(-15) };
      }
      onEvent({ step: "done", detail: `Pulled "${src.database}" → "${t.database}"` });
      return { database: t.database, url: t.url, warnings };
    } catch (err) {
      onEvent({ step: "error", detail: cancelled ? "Pull cancelled" : msg(err) });
      throw err;
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      try {
        if (existsSync(tmpDump)) unlinkSync(tmpDump);
      } catch {
        /* leave temp file if locked */
      }
    }
  })();

  return { result, cancel };
}
