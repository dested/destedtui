import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface PackageInfo {
  /** Absolute dir containing package.json */
  dir: string;
  /** Name from package.json, falls back to dir basename */
  name: string;
  /** Path relative to scan root, "." for the root itself */
  rel: string;
  scripts: Record<string, string>;
  pm: PackageManager;
}

export interface DatabaseInfo {
  /** Absolute path to the .env file */
  envPath: string;
  /** Absolute dir containing the .env (project folder — backups land here) */
  dir: string;
  /** Dir relative to scan root */
  rel: string;
  /** Which env key held the URL */
  key: string;
  url: string;
  /** Safe-to-display URL with password masked */
  redacted: string;
}

export interface Discovery {
  root: string;
  packages: PackageInfo[];
  databases: DatabaseInfo[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  "vendor",
  ".svelte-kit",
  ".vercel",
  ".expo",
  "__pycache__",
]);

const DB_URL_KEYS = ["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "PG_URL"];

/** Parse simple KEY=VALUE .env content. Handles `export`, quotes, comments. */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // strip trailing inline comment for unquoted values
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key) result[key] = value;
  }
  return result;
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:****@");
  }
}

function detectPm(dir: string, root: string): PackageManager {
  let current = dir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, "bun.lock")) || existsSync(join(current, "bun.lockb"))) return "bun";
    if (existsSync(join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(current, "yarn.lock"))) return "yarn";
    if (existsSync(join(current, "package-lock.json"))) return "npm";
    if (current === root) break;
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return "bun";
}

function isEnvFile(name: string): boolean {
  if (!name.startsWith(".env")) return false;
  if (name.includes("example") || name.includes("sample") || name.includes("template")) return false;
  return true;
}

/** Walk the tree from root, collecting package.json scripts and .env DATABASE_URLs. */
export function discover(root: string, maxDepth = 4): Discovery {
  const packages: PackageInfo[] = [];
  const databases: DatabaseInfo[] = [];

  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry) && !entry.startsWith(".")) walk(full, depth + 1);
        continue;
      }
      if (entry === "package.json") {
        try {
          const pkg = JSON.parse(readFileSync(full, "utf8"));
          const scripts: Record<string, string> =
            pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
          if (Object.keys(scripts).length > 0) {
            const rel = relative(root, dir) || ".";
            packages.push({
              dir,
              name: typeof pkg.name === "string" && pkg.name ? pkg.name : basename(dir),
              rel,
              scripts,
              pm: detectPm(dir, root),
            });
          }
        } catch {
          // unparseable package.json — skip
        }
      } else if (isEnvFile(entry)) {
        try {
          const env = parseEnv(readFileSync(full, "utf8"));
          for (const key of DB_URL_KEYS) {
            const url = env[key];
            if (url && /^postgres(ql)?:\/\//i.test(url)) {
              const rel = relative(root, dir) || ".";
              databases.push({ envPath: full, dir, rel, key, url, redacted: redactUrl(url) });
              break;
            }
          }
        } catch {
          // unreadable .env — skip
        }
      }
    }
  };

  walk(root, 0);
  packages.sort((a, b) => (a.rel === "." ? -1 : b.rel === "." ? 1 : a.rel.localeCompare(b.rel)));
  return { root, packages, databases };
}
