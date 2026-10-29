// The project panel's view of Drydock: which app this folder deploys as, how
// it's running, the names of its env vars, and how to reach its database.
//
// Everything goes through the portal's tRPC (http://localhost:4400/trpc). The
// one secret that crosses into this module is the database URL from
// projects.localDbUrl: it's held in memory for the session, handed to child
// processes through env, and never printed, logged or cached to disk.

import { z } from "zod";
import { serviceState, trpc, type ServiceState } from "../keys/drydock.ts";
import { folderIndex, mapApp, readDrydockCache } from "../keys/deployed.ts";

export interface DrydockApp {
  name: string;
  domain: string | null;
  repo: string;
  /** the app's config says it uses Postgres / Prisma */
  database: boolean;
  prisma: boolean;
  predeploy: string | null;
  desired: number;
  running: number;
}

const appSchema = z
  .object({
    name: z.string(),
    repo: z.string().default(""),
    config: z
      .object({
        rootDir: z.string().default(""),
        domains: z.array(z.string()).default([]),
        database: z.boolean().default(false),
        prisma: z.boolean().default(false),
        predeployCommand: z.string().default(""),
      })
      .passthrough(),
    state: z.object({ desired: z.number(), running: z.number() }).passthrough().nullable().default(null),
  })
  .passthrough();

/** Overrides set in keys (`keys drydock map`) live in the vault; the cache carries their result. */
function cachedOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of readDrydockCache()?.apps ?? []) if (a.mappedBy === "override") out[a.name] = a.folder ?? "-";
  return out;
}

/** The Drydock apps deployed from this folder (usually one). */
export async function appsForFolder(folder: string): Promise<DrydockApp[]> {
  const apps = await trpc("query", "projects.list", undefined, z.array(appSchema));
  const idx = folderIndex();
  const overrides = cachedOverrides();
  const want = folder.toLowerCase();
  return apps
    .filter((a) => mapApp(a, idx, overrides).folder?.toLowerCase() === want)
    .map((a) => ({
      name: a.name,
      domain: a.config.domains[0] ?? null,
      repo: a.repo,
      database: a.config.database,
      prisma: a.config.prisma,
      predeploy: a.config.predeployCommand || null,
      desired: a.state?.desired ?? 0,
      running: a.state?.running ?? 0,
    }));
}

/** Synchronous best guess for the first frame: the keys cache's mapping. */
export function cachedAppNames(folder: string): string[] {
  const want = folder.toLowerCase();
  return (readDrydockCache()?.apps ?? []).filter((a) => a.folder?.toLowerCase() === want).map((a) => a.name);
}

export interface AppDetail {
  state: ServiceState | null;
  /** var names in SSM, sorted */
  envNames: string[];
  error: string | null;
}

export async function appDetail(app: string): Promise<AppDetail> {
  const [state, env] = await Promise.allSettled([
    serviceState(app),
    trpc("query", "projects.env.list", { name: app }, z.record(z.string(), z.string().nullable())),
  ]);
  const err = [state, env].find((r) => r.status === "rejected");
  return {
    state: state.status === "fulfilled" ? state.value : null,
    envNames: env.status === "fulfilled" ? Object.keys(env.value).sort() : [],
    error: err && err.status === "rejected" ? (err.reason instanceof Error ? err.reason.message : String(err.reason)) : null,
  };
}

// ─── database reach ──────────────────────────────────────────────────────────

const platformSchema = z
  .object({
    eip: z.string().nullish(),
    instance: z.object({ id: z.string() }).passthrough().nullish(),
    dbPortOpenTo: z.array(z.string()).default([]),
  })
  .passthrough();

const boxSchema = z
  .object({ state: z.object({ instanceId: z.string().optional(), eipPublicIp: z.string().optional(), serving: z.boolean().default(false) }).passthrough().nullable() })
  .passthrough();

const settingsSchema = z.object({ region: z.string().default("us-west-2") }).passthrough();

export interface DbReach {
  /** postgres://… with the box's public IP — the secret */
  url: string;
  /** public IP of the box the database is on */
  host: string;
  /** EC2 instance an SSM tunnel goes through */
  instanceId: string | null;
  region: string;
  /** CIDRs the 5432 security-group rule allows (shared box only) */
  openTo: string[];
}

/** How to reach the app's database from here, or null when it has none. */
export async function dbReach(app: string): Promise<DbReach | null> {
  const [url, platform, box, settings] = await Promise.all([
    trpc("query", "projects.localDbUrl", { name: app }, z.object({ url: z.string(), host: z.string() }).nullable()),
    trpc("query", "platform.status", undefined, platformSchema),
    trpc("query", "projects.box.status", { name: app }, boxSchema),
    trpc("query", "platform.settings", undefined, settingsSchema).catch(() => ({ region: "us-west-2" })),
  ]);
  if (!url) return null;
  const dedicated = box.state?.serving && box.state.instanceId ? box.state.instanceId : null;
  return {
    url: url.url,
    host: url.host,
    instanceId: dedicated ?? platform.instance?.id ?? null,
    region: settings.region,
    openTo: dedicated ? [] : platform.dbPortOpenTo,
  };
}

