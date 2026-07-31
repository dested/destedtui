import type { PgConn } from "./pgurl.ts";
import { adminQuery, adminRows } from "./pgtools.ts";
import { isRecord, readConfig, patchConfig } from "./config.ts";

export interface LocalConn {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Defaults: PG* env vars if set, else the classic postgres/postgres@localhost:5432. */
export function defaultLocalConn(): LocalConn {
  return {
    host: process.env.PGHOST || "localhost",
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) || 5432 : 5432,
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD ?? "postgres",
  };
}

/** Load the saved localhost connection preset, falling back to defaults. */
export function loadLocalConn(): LocalConn {
  const def = defaultLocalConn();
  const l = readConfig().localhost;
  if (isRecord(l)) {
    return {
      host: typeof l.host === "string" && l.host ? l.host : def.host,
      port: typeof l.port === "number" && Number.isFinite(l.port) ? l.port : def.port,
      user: typeof l.user === "string" && l.user ? l.user : def.user,
      password: typeof l.password === "string" ? l.password : def.password,
    };
  }
  return def;
}

/** Persist the localhost connection preset to ~/.destedtui/config.json. */
export function saveLocalConn(conn: LocalConn): void {
  patchConfig({ localhost: conn });
}

/** Build a full PgConn (with URL) for a given database on the local server. */
export function localPgConn(local: LocalConn, database = "postgres"): PgConn {
  const auth = `${encodeURIComponent(local.user)}:${encodeURIComponent(local.password)}`;
  const url = `postgres://${auth}@${local.host}:${local.port}/${encodeURIComponent(database)}`;
  return {
    host: local.host,
    port: local.port,
    user: local.user,
    password: local.password,
    database,
    ssl: false,
    url,
  };
}

/** Display string for a connection, password masked. */
export function describeLocal(local: LocalConn): string {
  return `postgres://${local.user}:****@${local.host}:${local.port}`;
}

/** Parse a postgres URL into a LocalConn (used by the connection editor). */
export function parseLocalConn(raw: string): LocalConn {
  const u = new URL(raw);
  return {
    host: u.hostname || "localhost",
    port: u.port ? parseInt(u.port, 10) || 5432 : 5432,
    user: decodeURIComponent(u.username) || "postgres",
    password: decodeURIComponent(u.password),
  };
}

export interface LocalDbInfo {
  name: string;
  sizeBytes: number;
  owner: string;
  encoding: string;
}

/** List every non-template database on the server with size + owner. */
export async function listLocalDatabases(conn: PgConn): Promise<LocalDbInfo[]> {
  const rows = await adminRows<{ name: string; size: string | number; owner: string; encoding: string }>(
    conn,
    false,
    `SELECT d.datname AS name,
            pg_database_size(d.datname) AS size,
            pg_catalog.pg_get_userbyid(d.datdba) AS owner,
            pg_catalog.pg_encoding_to_char(d.encoding) AS encoding
       FROM pg_database d
      WHERE d.datistemplate = false
      ORDER BY pg_database_size(d.datname) DESC`,
  );
  return rows.map((r) => ({
    name: r.name,
    sizeBytes: Number(r.size),
    owner: r.owner,
    encoding: r.encoding,
  }));
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** CREATE DATABASE on the server. Throws if it already exists. */
export async function createLocalDatabase(conn: PgConn, name: string): Promise<void> {
  await adminQuery(conn, false, [`CREATE DATABASE ${quoteIdent(name)}`]);
}

/** Terminate backends then DROP DATABASE. */
export async function dropLocalDatabase(conn: PgConn, name: string): Promise<void> {
  await adminQuery(conn, false, [
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name.replace(/'/g, "''")}' AND pid <> pg_backend_pid()`,
    `DROP DATABASE IF EXISTS ${quoteIdent(name)}`,
  ]);
}
