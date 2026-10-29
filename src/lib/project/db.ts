// The databases a project can talk to, and a quick read of each: is it up,
// how big, how many tables, and how its migrations compare to the repo's.
//
// Targets come from every non-example .env in the project, plus the Drydock
// app's own database (its URL is fetched on demand and lives only in memory).

import { createConnection } from "node:net";
import pg from "pg";
import type { DatabaseInfo } from "../discovery.ts";
import { redactUrl } from "../discovery.ts";
import { msg } from "../pgtools.ts";
import { parsePgUrl } from "../pgurl.ts";

export type TargetKind = "local" | "remote" | "drydock";

export interface DbTarget {
  /** stable across rescans */
  id: string;
  kind: TargetKind;
  /** "local", ".env.production", "prod · anycardgame" */
  label: string;
  /** where it came from: an .env path, or the Drydock app */
  source: string;
  /** host:port/db, no credentials */
  where: string;
  /** set for .env targets; Drydock targets resolve through dbReach + the tunnel */
  url: string | null;
  /** Drydock app name, for drydock targets */
  app: string | null;
  envKey: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal", "0.0.0.0"]);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(parsePgUrl(url).host.toLowerCase());
  } catch {
    return false;
  }
}

export function whereOf(url: string): string {
  try {
    const c = parsePgUrl(url);
    return `${c.host}:${c.port}/${c.database}`;
  } catch {
    return redactUrl(url);
  }
}

function envLabel(db: DatabaseInfo): string {
  const file = db.envPath.replace(/^.*[\\/]/, "");
  return db.rel === "." ? file : `${db.rel.replace(/\\/g, "/")}/${file}`;
}

/** .env targets (deduped by host/port/db, first file wins) then one per Drydock app. */
export function buildTargets(databases: DatabaseInfo[], apps: string[]): DbTarget[] {
  const seen = new Set<string>();
  const out: DbTarget[] = [];
  for (const db of databases) {
    const where = whereOf(db.url);
    if (seen.has(where.toLowerCase())) continue;
    seen.add(where.toLowerCase());
    out.push({
      id: `env:${db.envPath}:${db.key}`,
      kind: isLocalUrl(db.url) ? "local" : "remote",
      label: envLabel(db),
      source: db.envPath,
      where,
      url: db.url,
      app: null,
      envKey: db.key,
    });
  }
  for (const app of apps) {
    out.push({ id: `drydock:${app}`, kind: "drydock", label: `prod · ${app}`, source: `drydock app ${app}`, where: "", url: null, app, envKey: "DATABASE_URL" });
  }
  return out;
}

export interface DbProbe {
  ok: boolean;
  version: string | null;
  bytes: number | null;
  tables: number | null;
  /** migration names recorded as applied (null = no _prisma_migrations table) */
  applied: string[] | null;
  /** rows in _prisma_migrations that failed or were rolled back */
  failed: number;
  error: string | null;
  at: number;
}

/** Can we open a TCP connection at all (the 5432 rule, a tunnel that's up)? */
export function tcpOpen(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((done) => {
    const s = createConnection({ host, port });
    const finish = (ok: boolean) => {
      s.removeAllListeners();
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}

/** One connection, four cheap queries. Never throws. */
export async function probeDb(url: string): Promise<DbProbe> {
  const at = Date.now();
  let conn;
  try {
    conn = parsePgUrl(url);
  } catch (err) {
    return { ok: false, version: null, bytes: null, tables: null, applied: null, failed: 0, error: `not a postgres url (${msg(err)})`, at };
  }
  const attempts = conn.ssl ? [{ rejectUnauthorized: false }, false as const] : [false as const, { rejectUnauthorized: false }];
  let lastErr: unknown = null;
  for (const ssl of attempts) {
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl,
      connectionTimeoutMillis: 6000,
      statement_timeout: 6000,
    });
    try {
      await client.connect();
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
      continue;
    }
    try {
      const v = await client.query<{ v: string; bytes: string; tables: string }>(
        `SELECT current_setting('server_version') AS v, pg_database_size(current_database())::text AS bytes,
                (SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE')::text AS tables`,
      );
      const row = v.rows[0];
      let applied: string[] | null = null;
      let failed = 0;
      const has = await client.query<{ t: string | null }>(`SELECT to_regclass('_prisma_migrations')::text AS t`);
      if (has.rows[0]?.t) {
        const m = await client.query<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
          `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at`,
        );
        applied = m.rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
        failed = m.rows.filter((r) => !r.finished_at || r.rolled_back_at).length;
      }
      return {
        ok: true,
        version: row ? (row.v.split(" ")[0] ?? row.v) : null,
        bytes: row ? Number(row.bytes) : null,
        tables: row ? Number(row.tables) : null,
        applied,
        failed,
        error: null,
        at,
      };
    } catch (err) {
      return { ok: false, version: null, bytes: null, tables: null, applied: null, failed: 0, error: msg(err), at };
    } finally {
      await client.end().catch(() => {});
    }
  }
  return { ok: false, version: null, bytes: null, tables: null, applied: null, failed: 0, error: shortPgError(lastErr), at };
}

function shortPgError(err: unknown): string {
  const m = msg(err);
  if (/ECONNREFUSED/.test(m)) return "nothing listening (connection refused)";
  if (/ETIMEDOUT|timeout/i.test(m)) return "timed out — firewall, or the server is down";
  if (/password authentication failed/i.test(m)) return "password rejected";
  if (/does not exist/i.test(m)) return m.replace(/^error:\s*/i, "");
  return m;
}

export interface MigrationDiff {
  /** in the repo, not applied */
  pending: string[];
  /** applied, not in the repo (another branch, or a deleted folder) */
  unknown: string[];
}

export function diffMigrations(repo: string[], applied: string[]): MigrationDiff {
  const a = new Set(applied);
  const r = new Set(repo);
  return { pending: repo.filter((m) => !a.has(m)), unknown: applied.filter((m) => !r.has(m)) };
}
