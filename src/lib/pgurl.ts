export interface PgConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** true when the URL asks for SSL (sslmode=require etc.) */
  ssl: boolean;
  url: string;
}

export function parsePgUrl(raw: string): PgConn {
  const u = new URL(raw);
  const sslmode = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl");
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  return {
    host: u.hostname || "localhost",
    port: u.port ? parseInt(u.port, 10) : 5432,
    user: decodeURIComponent(u.username) || "postgres",
    password: decodeURIComponent(u.password),
    database,
    ssl: sslmode !== null && sslmode !== "disable" && sslmode !== "false",
    url: raw,
  };
}

/** Same server, different database. */
export function withDatabase(conn: PgConn, database: string): PgConn {
  const u = new URL(conn.url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return { ...conn, database, url: u.toString() };
}

export function connString(conn: PgConn): string {
  return conn.url;
}
