import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import pg from "pg";
import type { PgConn } from "./pgurl.ts";

const { Client } = pg;

export const CACHE_DIR = join(homedir(), ".destedtui", "pg");

export interface PgTools {
  pgDump: string;
  pgRestore: string;
  /** "downloaded" = version-matched cached binaries, "path" = whatever is on PATH */
  source: "downloaded" | "path";
  /** major version of the tools, e.g. "16" or "9.6" */
  toolMajor: string;
}

export interface ServerInfo {
  /** e.g. "16.4" or "10.23" */
  version: string;
  /** e.g. "16" or "9.6" */
  major: string;
  /** whether SSL was required to connect */
  ssl: boolean;
}

export type ToolProgress = {
  phase: "connect" | "probe" | "download" | "extract" | "ready";
  detail: string;
  /** 0..1 when known */
  pct?: number;
};

/** Known-good EDB Windows x64 binary zips, newest first per major. Old files stay downloadable forever. */
const EDB_CANDIDATES: Record<string, string[]> = {
  "9.4": ["9.4.26-1"],
  "9.5": ["9.5.25-1"],
  "9.6": ["9.6.24-1"],
  "10": ["10.23-1"],
  "11": ["11.22-1", "11.21-1"],
  "12": ["12.22-1", "12.20-1", "12.18-1"],
  "13": ["13.21-1", "13.20-1", "13.18-1", "13.14-1"],
  "14": ["14.18-1", "14.17-1", "14.15-1", "14.11-1"],
  "15": ["15.13-1", "15.12-1", "15.10-1", "15.6-1"],
  "16": ["16.9-1", "16.8-1", "16.6-1", "16.4-1", "16.2-1"],
  "17": ["17.5-1", "17.4-1", "17.2-1", "17.0-1"],
  "18": ["18.1-1", "18.0-1"],
};

const MAJOR_ORDER = ["9.4", "9.5", "9.6", "10", "11", "12", "13", "14", "15", "16", "17", "18"];

export function majorOf(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) return version.split(".")[0] ?? version;
  const first = parseInt(m[1]!, 10);
  return first >= 10 ? String(first) : `${m[1]}.${m[2]}`;
}

function majorGte(a: string, b: string): boolean {
  return MAJOR_ORDER.indexOf(a) >= MAJOR_ORDER.indexOf(b);
}

/** Connect and read the server version; retries with relaxed SSL if plain connect fails. */
export async function detectServer(conn: PgConn): Promise<ServerInfo> {
  const attempts: Array<{ ssl: false | { rejectUnauthorized: false } }> = conn.ssl
    ? [{ ssl: { rejectUnauthorized: false } }, { ssl: false }]
    : [{ ssl: false }, { ssl: { rejectUnauthorized: false } }];
  let lastErr: unknown;
  for (const attempt of attempts) {
    const client = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl: attempt.ssl,
      connectionTimeoutMillis: 8000,
    });
    try {
      await client.connect();
      const res = await client.query("SHOW server_version");
      await client.end().catch(() => {});
      const version = String(res.rows[0]?.server_version ?? "").split(" ")[0]!;
      return { version, major: majorOf(version), ssl: attempt.ssl !== false };
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
    }
  }
  throw new Error(`Could not connect to ${conn.host}:${conn.port}/${conn.database}: ${msg(lastErr)}`);
}

/** Run an admin query (drop/create database etc.) against a maintenance DB on the same server. */
export async function adminQuery(
  conn: PgConn,
  ssl: boolean,
  queries: string[],
  maintenanceDb = "postgres",
): Promise<void> {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: maintenanceDb,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
  } catch (err) {
    if (maintenanceDb === "postgres") {
      await client.end().catch(() => {});
      return adminQuery(conn, ssl, queries, "template1");
    }
    throw new Error(`Could not connect to maintenance database: ${msg(err)}`);
  }
  try {
    for (const q of queries) await client.query(q);
  } finally {
    await client.end().catch(() => {});
  }
}

function binName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function cachedTools(major: string): PgTools | null {
  const bin = join(CACHE_DIR, major, "bin");
  const pgDump = join(bin, binName("pg_dump"));
  const pgRestore = join(bin, binName("pg_restore"));
  if (existsSync(pgDump) && existsSync(pgRestore)) {
    return { pgDump, pgRestore, source: "downloaded", toolMajor: major };
  }
  return null;
}

async function toolsFromPath(serverMajor: string, onProgress: (p: ToolProgress) => void): Promise<PgTools | null> {
  const pgDump = Bun.which(binName("pg_dump").replace(/\.exe$/, ""));
  const pgRestore = Bun.which(binName("pg_restore").replace(/\.exe$/, ""));
  if (!pgDump || !pgRestore) return null;
  try {
    const proc = Bun.spawn([pgDump, "--version"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const version = out.match(/(\d+(?:\.\d+)+)/)?.[1] ?? "0";
    const toolMajor = majorOf(version);
    if (!majorGte(toolMajor, serverMajor)) {
      onProgress({
        phase: "probe",
        detail: `pg_dump on PATH is v${version} — older than server v${serverMajor}, not usable`,
      });
      return null;
    }
    return { pgDump, pgRestore, source: "path", toolMajor };
  } catch {
    return null;
  }
}

/**
 * Ensure pg_dump/pg_restore matching the server's major version.
 * Windows: downloads official EDB binary zips and caches ~50MB of bin/ per major
 * under ~/.destedtui/pg/<major>. Other platforms (and download failure): falls
 * back to PATH tools when their version is >= the server's.
 */
export async function ensureTools(serverMajor: string, onProgress: (p: ToolProgress) => void): Promise<PgTools> {
  const cached = cachedTools(serverMajor);
  if (cached) {
    onProgress({ phase: "ready", detail: `Using cached PostgreSQL ${serverMajor} tools` });
    return cached;
  }

  if (process.platform === "win32") {
    const candidates = EDB_CANDIDATES[serverMajor] ?? [];
    for (const version of candidates) {
      const url = `https://get.enterprisedb.com/postgresql/postgresql-${version}-windows-x64-binaries.zip`;
      onProgress({ phase: "probe", detail: `Checking ${version}...` });
      try {
        const res = await fetch(url);
        if (!res.ok || !res.body) continue;
        const total = parseInt(res.headers.get("content-length") ?? "0", 10);
        const destBin = join(CACHE_DIR, serverMajor, "bin");
        mkdirSync(destBin, { recursive: true });
        await extractPgsqlBin(res.body, destBin, total, version, onProgress);
        const tools = cachedTools(serverMajor);
        if (tools) {
          onProgress({ phase: "ready", detail: `PostgreSQL ${version} tools installed` });
          return tools;
        }
      } catch (err) {
        onProgress({ phase: "probe", detail: `Download of ${version} failed: ${msg(err)}` });
      }
    }
  }

  const fromPath = await toolsFromPath(serverMajor, onProgress);
  if (fromPath) {
    onProgress({ phase: "ready", detail: `Using pg tools v${fromPath.toolMajor} from PATH` });
    return fromPath;
  }

  throw new Error(
    process.platform === "win32"
      ? `Could not download PostgreSQL ${serverMajor} tools and no compatible pg_dump on PATH.`
      : `No compatible pg_dump/pg_restore on PATH (need version >= ${serverMajor}). Install postgresql client tools.`,
  );
}

/** Stream-extract only pgsql/bin/* from the EDB zip, writing directly to destBin. */
async function extractPgsqlBin(
  body: ReadableStream<Uint8Array>,
  destBin: string,
  totalBytes: number,
  version: string,
  onProgress: (p: ToolProgress) => void,
): Promise<void> {
  const writers = new Map<string, ReturnType<typeof createWriteStream>>();
  const done: Promise<void>[] = [];
  let extractError: unknown = null;

  const unzip = new Unzip((file) => {
    const name = file.name.replace(/\\/g, "/");
    if (!name.startsWith("pgsql/bin/") || name.endsWith("/")) return;
    const rel = name.slice("pgsql/bin/".length);
    if (!rel || rel.includes("/")) return; // flat bin dir only
    const outPath = join(destBin, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    const ws = createWriteStream(outPath);
    writers.set(name, ws);
    done.push(new Promise((resolve, reject) => ws.on("close", resolve).on("error", reject)));
    file.ondata = (err, data, final) => {
      if (err) {
        extractError = err;
        ws.destroy();
        return;
      }
      if (data.length) ws.write(Buffer.from(data));
      if (final) ws.end();
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const reader = body.getReader();
  let received = 0;
  let lastPct = -1;
  for (;;) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    received += value.length;
    unzip.push(value, false);
    if (extractError) throw extractError;
    if (totalBytes > 0) {
      const pct = Math.floor((received / totalBytes) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress({
          phase: "download",
          detail: `Downloading PostgreSQL ${version} (${fmtBytes(received)} / ${fmtBytes(totalBytes)})`,
          pct: received / totalBytes,
        });
      }
    } else {
      onProgress({ phase: "download", detail: `Downloading PostgreSQL ${version} (${fmtBytes(received)})` });
    }
  }
  unzip.push(new Uint8Array(0), true);
  onProgress({ phase: "extract", detail: "Extracting tools..." });
  await Promise.all(done);
  if (extractError) throw extractError;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
