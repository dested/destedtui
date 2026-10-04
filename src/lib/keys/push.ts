// `keys push <project>`: put a project's keys into its Drydock apps' env (SSM,
// through the portal), then Apply + redeploy and follow the deployment.

import { applyAndRedeploy, envPrints, setEnv, waitForDeploy, type DeployOutcome, type EnvPrint } from "./drydock.ts";
import { getDrydock, providerVarNames, type MappedApp } from "./deployed.ts";
import { UserError } from "./errors.ts";
import { resolveProject } from "./ops.ts";
import { envVarFor, isActive, providerById, readVault, type KeyRecord, type Vault } from "./vault.ts";

export interface PushSet {
  envVar: string;
  keyId: string;
  providerId: string;
  fingerprint: string;
  change: "add" | "update" | "same";
}

export interface PushAppResult {
  app: string;
  sets: PushSet[];
  /** Apply + redeploy ran (or would, in a dry run). */
  applied: boolean;
  deploy?: DeployOutcome;
}

export interface PushResult {
  project: string;
  dryRun: boolean;
  apps: PushAppResult[];
}

/**
 * Which app vars a key goes into: every var the app already has under one of the
 * provider's names; otherwise the provider's server-side name (a VITE_ name is a
 * build-time var, useless in a running container's env).
 */
export function targetVars(v: Vault, k: KeyRecord, env: EnvPrint): string[] {
  const p = providerById(v, k.providerId);
  const names = new Set([envVarFor(v, k), ...(p ? providerVarNames(p) : [])]);
  const present = Object.keys(env).filter((n) => names.has(n));
  if (present.length) return present;
  const own = envVarFor(v, k);
  return [own.startsWith("VITE_") && p ? p.envVar : own];
}

export function appsFor(apps: MappedApp[], project: string, only?: string): MappedApp[] {
  const mine = apps.filter((a) => a.folder?.toLowerCase() === project.toLowerCase());
  if (!only) return mine;
  const hit = mine.find((a) => a.name === only);
  if (!hit) throw new UserError(`${only} isn't a Drydock app of ${project} (${mine.map((a) => a.name).join(", ") || "none"})`);
  return [hit];
}

export async function pushProject(
  projectName: string,
  opts: { providerId?: string; app?: string; redeploy?: boolean; dryRun?: boolean; onTick?: (line: string) => void } = {},
): Promise<PushResult> {
  const project = resolveProject(projectName);
  const v = readVault();
  const { cache, error } = await getDrydock(v, { refresh: true });
  if (!cache) throw new UserError(`can't reach Drydock: ${error ?? "no data"}`);
  if (error) throw new UserError(`Drydock portal unreachable (${error}) — not pushing on stale data`);
  const apps = appsFor(cache.apps, project.slug, opts.app);
  if (apps.length === 0) throw new UserError(`${project.slug} isn't deployed on Drydock (map it with: keys drydock map <app> ${project.slug})`);
  const keys = v.keys.filter((k) => isActive(k) && k.project.toLowerCase() === project.slug.toLowerCase() && (!opts.providerId || k.providerId === opts.providerId));
  if (keys.length === 0) throw new UserError(`${project.slug} has no active ${opts.providerId ? `${opts.providerId} ` : ""}keys to push`);
  const result: PushResult = { project: project.slug, dryRun: Boolean(opts.dryRun), apps: [] };
  for (const app of apps) {
    const env = await envPrints(app.name);
    const sets: PushSet[] = [];
    for (const k of keys)
      for (const envVar of targetVars(v, k, env)) {
        const now = env[envVar];
        sets.push({ envVar, keyId: k.id, providerId: k.providerId, fingerprint: k.fingerprint, change: now === undefined ? "add" : now === k.fingerprint ? "same" : "update" });
      }
    const changed = sets.filter((s) => s.change !== "same");
    const res: PushAppResult = { app: app.name, sets, applied: false };
    result.apps.push(res);
    if (changed.length === 0) continue;
    if (opts.dryRun) {
      res.applied = opts.redeploy !== false;
      continue;
    }
    for (const s of changed) {
      const k = keys.find((x) => x.id === s.keyId);
      if (k) await setEnv(app.name, s.envVar, k.value);
    }
    if (opts.redeploy === false) continue;
    const since = Date.now();
    opts.onTick?.(`${app.name}: apply + redeploy`);
    await applyAndRedeploy(app.name);
    res.applied = true;
    res.deploy = await waitForDeploy(app.name, since, { onTick: (l) => opts.onTick?.(`${app.name}: ${l}`) });
  }
  return result;
}
