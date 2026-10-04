// Which projects are deployed on Drydock, and which keys those deployments use.
//
// App → folder: a manual override (vault.drydock.overrides) wins; otherwise the
// folder whose git origin is the app's repo; otherwise a folder named like the app.
// Env: every app's SSM env is read through the portal and fingerprinted, so a
// deployed app can be matched to vault keys without a value ever being kept.
// Cached in ~/.destedtui/keys/drydock.json (names + fingerprints, no values).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { projectsRoot } from "../projects.ts";
import { envPrints, listApps, type DrydockApp } from "./drydock.ts";
import { mutate, VAULT_DIR, type Provider, type Vault } from "./vault.ts";
import { UserError } from "./errors.ts";

export const DRYDOCK_CACHE = join(VAULT_DIR, "drydock.json");
export const DRYDOCK_STALE_MS = 15 * 60_000;

const mappedAppSchema = z.object({
  name: z.string(),
  repo: z.string(),
  rootDir: z.string(),
  domain: z.string().nullable(),
  desired: z.number(),
  running: z.number(),
  /** Folder under the projects root, or null when nothing matched. */
  folder: z.string().nullable(),
  mappedBy: z.enum(["override", "repo", "name"]).nullable(),
  /** var → fingerprint (null = name without a value); null when the env couldn't be read. */
  env: z.record(z.string(), z.string().nullable()).nullable(),
  envError: z.string().optional(),
});
export type MappedApp = z.infer<typeof mappedAppSchema>;

const cacheSchema = z.object({ fetchedAt: z.string(), apps: z.array(mappedAppSchema) });
export type DrydockCache = z.infer<typeof cacheSchema>;

// ─── folder index ────────────────────────────────────────────────────────────

/** owner/repo (lowercased) from a folder's .git/config origin, if any. */
function originOf(dir: string): string | undefined {
  const cfg = join(dir, ".git", "config");
  if (!existsSync(cfg)) return undefined;
  let text: string;
  try {
    text = readFileSync(cfg, "utf8");
  } catch {
    return undefined;
  }
  const section = /\[remote "origin"\]([^[]*)/.exec(text)?.[1] ?? "";
  const url = /url\s*=\s*(\S+)/.exec(section)?.[1];
  const m = url ? /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(url) : null;
  return m?.[1] && m[2] ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface FolderIndex {
  folders: string[];
  byRepo: Map<string, string[]>;
}

export function folderIndex(root = projectsRoot()): FolderIndex {
  const byRepo = new Map<string, string[]>();
  const folders: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return { folders, byRepo };
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    folders.push(name);
    const repo = originOf(dir);
    if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), name]);
  }
  return { folders, byRepo };
}

export function mapApp(app: Pick<DrydockApp, "name" | "repo">, idx: FolderIndex, overrides: Record<string, string>): Pick<MappedApp, "folder" | "mappedBy"> {
  const o = overrides[app.name];
  if (o) return o === "-" ? { folder: null, mappedBy: "override" } : { folder: o, mappedBy: "override" };
  const byRepo = app.repo ? idx.byRepo.get(app.repo.toLowerCase()) : undefined;
  if (byRepo?.length) {
    // Several clones of one repo: prefer the one named like the app or the repo.
    const repoName = squash(app.repo.split("/")[1] ?? "");
    const best = byRepo.find((f) => squash(f) === squash(app.name)) ?? byRepo.find((f) => squash(f) === repoName) ?? byRepo[0];
    if (best) return { folder: best, mappedBy: "repo" };
  }
  const repoName = squash(app.repo.split("/")[1] ?? "");
  const byName = idx.folders.find((f) => squash(f) === squash(app.name)) ?? (repoName ? idx.folders.find((f) => squash(f) === repoName) : undefined);
  return byName ? { folder: byName, mappedBy: "name" } : { folder: null, mappedBy: null };
}

// ─── cache ───────────────────────────────────────────────────────────────────

export function readDrydockCache(): DrydockCache | null {
  if (!existsSync(DRYDOCK_CACHE)) return null;
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(DRYDOCK_CACHE, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeDrydockCache(c: DrydockCache): void {
  mkdirSync(VAULT_DIR, { recursive: true });
  const tmp = `${DRYDOCK_CACHE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cacheSchema.parse(c), null, 2));
  renameSync(tmp, DRYDOCK_CACHE);
}

/** Re-map a cache against the current overrides (cheap; no network). */
function remap(c: DrydockCache, vault: Vault): DrydockCache {
  const idx = folderIndex();
  return { ...c, apps: c.apps.map((a) => ({ ...a, ...mapApp(a, idx, vault.drydock.overrides) })) };
}

/** The cached picture, re-mapped against current overrides — synchronous, for a screen's first frame. */
export function cachedDrydock(vault: Vault): DrydockCache | null {
  const c = readDrydockCache();
  return c ? remap(c, vault) : null;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        const item = items[i];
        if (item !== undefined) out[i] = await fn(item);
      }
    }),
  );
  return out;
}

/** Ask the portal for every app and its env, map them to folders, cache the result. */
export async function fetchDrydock(vault: Vault): Promise<DrydockCache> {
  const apps = await listApps();
  const idx = folderIndex();
  const mapped = await pool(apps, 6, async (a): Promise<MappedApp> => {
    const base = { ...a, ...mapApp(a, idx, vault.drydock.overrides) };
    try {
      return { ...base, env: await envPrints(a.name) };
    } catch (err) {
      return { ...base, env: null, envError: err instanceof Error ? err.message : String(err) };
    }
  });
  const cache: DrydockCache = { fetchedAt: new Date().toISOString(), apps: mapped };
  writeDrydockCache(cache);
  return cache;
}

/**
 * The Drydock picture: cached when fresh, refetched when stale or asked; a portal
 * that is down falls back to the last cache (callers show its age).
 */
export async function getDrydock(vault: Vault, opts: { refresh?: boolean; cacheOnly?: boolean } = {}): Promise<{ cache: DrydockCache | null; error?: string }> {
  const cached = readDrydockCache();
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < DRYDOCK_STALE_MS;
  if (opts.cacheOnly || (fresh && !opts.refresh)) return { cache: cached ? remap(cached, vault) : null };
  try {
    return { cache: await fetchDrydock(vault) };
  } catch (err) {
    return { cache: cached ? remap(cached, vault) : null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setOverride(app: string, folder: string | null): Promise<void> {
  let target = folder;
  if (folder && folder !== "-") {
    const want = folder.toLowerCase();
    const hit = folderIndex().folders.find((f) => f.toLowerCase() === want);
    if (!hit) throw new UserError(`no folder "${folder}" in ${projectsRoot()}`);
    target = hit;
  }
  await mutate((v) => {
    if (target === null) delete v.drydock.overrides[app];
    else v.drydock.overrides[app] = target;
  });
}

// ─── who uses what ───────────────────────────────────────────────────────────

/** Folder (lowercased) → the Drydock apps deployed from it. */
export function deployedFolders(cache: DrydockCache | null): Map<string, MappedApp[]> {
  const m = new Map<string, MappedApp[]>();
  for (const a of cache?.apps ?? []) {
    if (!a.folder) continue;
    const k = a.folder.toLowerCase();
    m.set(k, [...(m.get(k) ?? []), a]);
  }
  return m;
}

/** The env var names a provider's key can go by. */
export function providerVarNames(p: Provider): string[] {
  return [p.envVar, ...p.aliases, ...p.aliases.concat(p.envVar).map((v) => `VITE_${v}`)];
}

export type AppKeyUse = "uses" | "maybe";

export interface AppUse {
  app: MappedApp;
  vars: string[];
  /** uses = a var's fingerprint matches; maybe = a provider var is present but its value is unknown. */
  how: AppKeyUse;
}

/** Deployed apps that use (or might use) the key with this fingerprint. */
export function appsUsing(cache: DrydockCache | null, fp: string, provider: Provider | undefined): AppUse[] {
  const names = provider ? new Set(providerVarNames(provider)) : new Set<string>();
  const out: AppUse[] = [];
  for (const app of cache?.apps ?? []) {
    if (!app.env) {
      // Env unreadable: any app might hold it. Only flag apps from folders we can't rule out.
      out.push({ app, vars: [], how: "maybe" });
      continue;
    }
    const hits = Object.entries(app.env).filter(([, v]) => v === fp).map(([k]) => k);
    if (hits.length) {
      out.push({ app, vars: hits, how: "uses" });
      continue;
    }
    const unknown = Object.entries(app.env).filter(([k, v]) => v === null && names.has(k)).map(([k]) => k);
    if (unknown.length) out.push({ app, vars: unknown, how: "maybe" });
  }
  return out;
}

export function ddMark(deployed: Map<string, MappedApp[]>, project: string): string {
  return deployed.has(project.toLowerCase()) ? " [dd]" : "";
}
