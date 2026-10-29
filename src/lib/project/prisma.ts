// Prisma in a project: where each schema is, what it declares, which migrations
// ship with it, and the CLI that runs against it. Pure fs — the database side
// (what's applied) lives in db.ts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { PackageInfo, PackageManager } from "../discovery.ts";

export interface PrismaSchema {
  /** the package that owns it — prisma commands run here */
  pkgDir: string;
  /** that package relative to the project ("." for the root) */
  rel: string;
  pm: PackageManager;
  /** schema.prisma, or the folder of a multi-file schema */
  schemaPath: string;
  /** the folder migrations/ lives in */
  schemaDir: string;
  provider: string | null;
  models: string[];
  enums: number;
  /** migration folder names, oldest first; empty for a `db push` project */
  migrations: string[];
  /** a prisma.config.ts is in charge (Prisma 6.6+/7) */
  config: string | null;
  /** the prisma package version in package.json, as written */
  version: string | null;
  /** an `env("X")` the datasource reads, when it isn't DATABASE_URL */
  urlEnv: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function deps(pkg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["dependencies", "devDependencies"]) {
    const d = pkg[k];
    if (d && typeof d === "object") for (const [n, v] of Object.entries(d)) if (typeof v === "string") out[n] = v;
  }
  return out;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Prisma's own lookup order: package.json `prisma.schema`, prisma.config.ts `schema:`, then the defaults. */
function locate(pkgDir: string, pkg: Record<string, unknown> | null, config: string | null): string | null {
  const fromPkg = pkg?.prisma && typeof pkg.prisma === "object" ? (pkg.prisma as Record<string, unknown>).schema : undefined;
  const candidates: string[] = [];
  if (typeof fromPkg === "string") candidates.push(join(pkgDir, fromPkg));
  if (config) {
    const m = /schema\s*:\s*["'`]([^"'`]+)["'`]/.exec(readFileSync(config, "utf8"));
    if (m?.[1]) candidates.push(join(pkgDir, m[1]));
  }
  candidates.push(join(pkgDir, "prisma", "schema.prisma"), join(pkgDir, "schema.prisma"), join(pkgDir, "prisma", "schema"));
  return candidates.find((c) => existsSync(c)) ?? null;
}

function schemaText(schemaPath: string): string {
  if (!isDir(schemaPath)) return readFileSync(schemaPath, "utf8");
  return readdirSync(schemaPath)
    .filter((f) => f.endsWith(".prisma"))
    .map((f) => readFileSync(join(schemaPath, f), "utf8"))
    .join("\n");
}

function inspect(pkgDir: string, rel: string, pm: PackageManager): PrismaSchema | null {
  const pkg = readJson(join(pkgDir, "package.json"));
  const d = pkg ? deps(pkg) : {};
  const config = ["prisma.config.ts", "prisma.config.mts", "prisma.config.js"].map((f) => join(pkgDir, f)).find((f) => existsSync(f)) ?? null;
  const schemaPath = locate(pkgDir, pkg, config);
  if (!schemaPath) return null;
  if (!d.prisma && !d["@prisma/client"] && !config) return null;
  let text = "";
  try {
    text = schemaText(schemaPath);
  } catch {
    /* unreadable — still a prisma package */
  }
  const datasource = /datasource\s+\w+\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  const provider = /provider\s*=\s*"([^"]+)"/.exec(datasource)?.[1] ?? null;
  const urlEnv = /url\s*=\s*env\(\s*"([^"]+)"\s*\)/.exec(datasource)?.[1] ?? "DATABASE_URL";
  const models = [...text.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((m) => m[1] ?? "").filter(Boolean);
  const enums = [...text.matchAll(/^\s*enum\s+\w+\s*\{/gm)].length;
  const schemaDir = dirname(schemaPath);
  const migDir = [join(isDir(schemaPath) ? schemaPath : schemaDir, "migrations"), join(schemaDir, "migrations")].find(isDir);
  const migrations = migDir
    ? readdirSync(migDir)
        .filter((f) => isDir(join(migDir, f)) && existsSync(join(migDir, f, "migration.sql")))
        .sort()
    : [];
  return { pkgDir, rel, pm, schemaPath, schemaDir, provider, models, enums, migrations, config, version: d.prisma ?? d["@prisma/client"] ?? null, urlEnv };
}

/** Every prisma schema in the project, root package first. */
export function findSchemas(projectDir: string, packages: PackageInfo[]): PrismaSchema[] {
  const dirs = new Map<string, { rel: string; pm: PackageManager }>();
  dirs.set(projectDir.toLowerCase(), { rel: ".", pm: packages.find((p) => p.rel === ".")?.pm ?? "bun" });
  for (const p of packages) if (!dirs.has(p.dir.toLowerCase())) dirs.set(p.dir.toLowerCase(), { rel: relative(projectDir, p.dir) || ".", pm: p.pm });
  const out: PrismaSchema[] = [];
  for (const { rel, pm } of dirs.values()) {
    const s = inspect(rel === "." ? projectDir : join(projectDir, rel), rel, pm);
    if (s) out.push(s);
  }
  return out;
}

/** The project's own prisma CLI through its package manager (never a global one). */
export function prismaCli(pm: PackageManager): string {
  switch (pm) {
    case "bun":
      return "bunx prisma";
    case "pnpm":
      return "pnpm exec prisma";
    case "yarn":
      return "yarn prisma";
    case "npm":
      return "npx prisma";
  }
}

/**
 * Prisma subcommands the panel offers. `remote` is what it may do to a database
 * that isn't on this machine: ok, only after a second press, or never
 * (`migrate dev` can reset a database; it's for your local one only).
 */
export const PRISMA_ACTIONS = [
  { id: "status", label: "migrate status", args: "migrate status", remote: "ok", needsMigrations: true },
  { id: "generate", label: "generate", args: "generate", remote: "ok", needsMigrations: false },
  { id: "dev", label: "migrate dev", args: "migrate dev", remote: "never", needsMigrations: false },
  { id: "push", label: "db push", args: "db push", remote: "confirm", needsMigrations: false },
  { id: "deploy", label: "migrate deploy", args: "migrate deploy", remote: "confirm", needsMigrations: true },
] as const;
export type PrismaAction = (typeof PRISMA_ACTIONS)[number];
export type PrismaActionId = PrismaAction["id"];
