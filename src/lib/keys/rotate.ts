// The rotate flow: replace one shared key with one key per project, then revoke
// the shared one. Also the batch revoke of dead shared keys.
//
// A rotation is a record in the vault (vault.rotations), so a walk survives
// quitting halfway. Each project planned "new" goes through four steps — create,
// .env, Drydock push (deployed only), verify — and every step function takes
// `dryRun`, which describes the step and changes nothing. The old key is revoked
// only once every "new" project is done and verified and no deployed app still
// holds (or might hold) the old value.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { openInChrome } from "../run.ts";
import { activityOf, type Activity } from "./activity.ts";
import { appsUsing, deployedFolders, getDrydock, type AppUse, type DrydockCache, type MappedApp } from "./deployed.ts";
import { removeFromEnv } from "./envfile.ts";
import { UserError } from "./errors.ts";
import { addKey, adapterFor, consoleHint, mintAbility, newKey, resolveProject, revokeRemote, writeEnv, type RemoteRevoke } from "./ops.ts";
import { pushProject } from "./push.ts";
import { readUsageCache } from "./usage/cache.ts";
import { buildView } from "./usage/view.ts";
import { describeCheck, verifyKey } from "./verify.ts";
import {
  envVarFor,
  isActive,
  mutate,
  providerById,
  readVault,
  reuseGroups,
  type KeyRecord,
  type Provider,
  type Rotation,
  type RotationProject,
  type Vault,
} from "./vault.ts";

export type Plan = "new" | "cutoff";

export interface Member {
  project: string;
  /** Vault records holding the old value in this project (active ones). */
  keyIds: string[];
  activity: Activity;
  /** Drydock apps deployed from this folder, and whether each holds this key. */
  apps: { name: string; how: "uses" | "maybe" | "other" }[];
  defaultPlan: Plan;
  plan: Plan;
  /** Why the default is what it is ("active 2d ago", "deployed: dink", "dead — last 4mo ago"). */
  why: string;
  /** Present when a rotation is under way. */
  progress?: RotationProject;
}

export interface SharedKey {
  fingerprint: string;
  providerId: string;
  provider: Provider | undefined;
  /** 7-day $ attributed to this value in the usage cache, null when nothing is cached. */
  usd7: number | null;
  members: Member[];
  /** Deployed apps that hold (or might hold) the value but map to no local folder. */
  strays: AppUse[];
  rotation?: Rotation;
  /** No active member and no deployed app holding or possibly holding it. */
  dead: boolean;
  /** Dead except for apps whose env value is unknown — needs an explicit override to revoke. */
  blockedBy: string[];
}

const DAY = 86_400_000;

export function agoText(ms: number | null, now = Date.now()): string {
  if (ms === null) return "never";
  const d = (now - ms) / DAY;
  if (d < 1 / 24) return "just now";
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 60) return `${Math.round(d)}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

/** $ over the cached window for each fingerprint (summed over every provider-side key matched to it). */
export function usdByFingerprint(v: Vault): Map<string, number> {
  const out = new Map<string, number>();
  const cache = readUsageCache();
  if (!cache) return out;
  const fpOf = new Map(v.keys.map((k) => [k.id, k.fingerprint]));
  for (const line of buildView(cache, v).lines)
    for (const k of line.keys) {
      const fps = new Set(k.vaultKeyIds.flatMap((id) => fpOf.get(id) ?? []));
      for (const fp of fps) out.set(fp, (out.get(fp) ?? 0) + (k.usd?.window ?? 0));
    }
  return out;
}

function memberFor(project: string, keyIds: string[], uses: AppUse[], deployed: Map<string, MappedApp[]>, plans: Record<string, Plan>, progress?: RotationProject): Member {
  const activity = activityOf(project);
  const apps = (deployed.get(project.toLowerCase()) ?? []).map((a) => ({
    name: a.name,
    how: uses.find((u) => u.app.name === a.name)?.how ?? ("other" as const),
  }));
  const defaultPlan: Plan = activity.active || apps.length > 0 ? "new" : "cutoff";
  const why = apps.length
    ? `deployed: ${apps.map((a) => a.name).join(", ")}`
    : activity.active
      ? `active ${agoText(activity.lastAt)}`
      : `dead — last ${agoText(activity.lastAt)}`;
  return { project, keyIds, activity, apps, defaultPlan, plan: progress?.plan ?? plans[project] ?? defaultPlan, why, progress };
}

/** Every value's records, active or not — a finished rotation still needs the old value's details. */
function recordsOf(v: Vault, fp: string): KeyRecord[] {
  return v.keys.filter((k) => k.fingerprint === fp);
}

export function liveRotation(v: Vault, fp: string): Rotation | undefined {
  return v.rotations.find((r) => r.fingerprint === fp && r.status === "walking");
}

/**
 * The shared key as the rotate screen shows it. While a rotation is walking its
 * members come from the rotation record (projects already moved to a new key no
 * longer share the old one, so the reuse group alone would forget them).
 */
export function sharedKey(v: Vault, cache: DrydockCache | null, fp: string, plans: Record<string, Plan> = {}, usd?: Map<string, number>): SharedKey {
  const records = recordsOf(v, fp);
  const first = records[0];
  if (!first) throw new UserError(`no key with fingerprint ${fp} in the vault`);
  const provider = providerById(v, first.providerId);
  const uses = appsUsing(cache, fp, provider);
  const deployed = deployedFolders(cache);
  const rotation = liveRotation(v, fp);
  const active = records.filter(isActive);
  const byProject = new Map<string, string[]>();
  for (const k of active) byProject.set(k.project, [...(byProject.get(k.project) ?? []), k.id]);
  // Folders whose deployed app holds the value but whose .env doesn't: they need a new key too.
  for (const u of uses) if (u.how === "uses" && u.app.folder && !byProject.has(u.app.folder)) byProject.set(u.app.folder, []);
  const members: Member[] = rotation
    ? rotation.projects.map((rp) => memberFor(rp.project, byProject.get(rp.project) ?? [], uses, deployed, plans, rp))
    : [...byProject.entries()].map(([p, ids]) => memberFor(p, ids, uses, deployed, plans));
  const memberSet = new Set(members.map((m) => m.project.toLowerCase()));
  const strays = uses.filter((u) => !u.app.folder || !memberSet.has(u.app.folder.toLowerCase()));
  const anyActive = members.some((m) => m.activity.active);
  const knownUse = uses.some((u) => u.how === "uses");
  const maybe = uses.filter((u) => u.how === "maybe");
  const dead = !anyActive && !knownUse && maybe.length === 0;
  const blockedBy = !anyActive && !knownUse && maybe.length ? maybe.map((u) => `${u.app.name} (${u.vars.join(", ") || "env unreadable"}: value unknown)`) : [];
  members.sort((a, b) => (a.plan === b.plan ? 0 : a.plan === "new" ? -1 : 1) || (b.activity.lastAt ?? 0) - (a.activity.lastAt ?? 0));
  return { fingerprint: fp, providerId: first.providerId, provider, usd7: (usd ?? usdByFingerprint(v)).get(fp) ?? null, members, strays, rotation, dead, blockedBy };
}

/** Every key shared between projects, plus any value a rotation is still walking; hottest first. */
export function sharedKeys(v: Vault, cache: DrydockCache | null): SharedKey[] {
  const usd = usdByFingerprint(v);
  const fps = new Set([...reuseGroups(v).map((g) => g.fingerprint), ...v.rotations.filter((r) => r.status === "walking").map((r) => r.fingerprint)]);
  return [...fps]
    .map((fp) => sharedKey(v, cache, fp, {}, usd))
    .sort((a, b) => (b.rotation ? 1 : 0) - (a.rotation ? 1 : 0) || (b.usd7 ?? 0) - (a.usd7 ?? 0) || b.members.length - a.members.length);
}

// ─── the walk ────────────────────────────────────────────────────────────────

export type StepName = "create" | "env" | "push" | "verify";
export const STEP_LABEL: Record<StepName, string> = { create: "new key", env: ".env", push: "drydock", verify: "verify" };

export function stepsFor(m: Pick<Member, "apps">): StepName[] {
  return m.apps.length ? ["create", "env", "push", "verify"] : ["create", "env", "verify"];
}

export function stepDone(rp: RotationProject | undefined, step: StepName): boolean {
  if (!rp) return false;
  if (step === "create") return Boolean(rp.keyId && rp.created);
  if (step === "env") return Boolean(rp.env);
  if (step === "push") return Boolean(rp.pushed);
  return rp.verified?.ok === true;
}

export function memberDone(m: Member): boolean {
  return m.plan === "cutoff" || stepsFor(m).every((s) => stepDone(m.progress, s));
}

export function nextStep(k: SharedKey): { member: Member; step: StepName } | null {
  for (const m of k.members) {
    if (m.plan !== "new") continue;
    const step = stepsFor(m).find((s) => !stepDone(m.progress, s));
    if (step) return { member: m, step };
  }
  return null;
}

export function progressText(k: SharedKey): string {
  const news = k.members.filter((m) => m.plan === "new");
  return `${news.filter(memberDone).length}/${news.length} done`;
}

/** Start (or re-plan) the rotation for a value: the plans become durable in the vault. */
export async function startRotation(fp: string, members: Pick<Member, "project" | "plan" | "apps">[]): Promise<Rotation> {
  return mutate((v) => {
    const first = recordsOf(v, fp)[0];
    if (!first) throw new UserError(`no key with fingerprint ${fp}`);
    const now = new Date().toISOString();
    const existing = liveRotation(v, fp);
    if (existing) {
      for (const m of members) {
        const rp = existing.projects.find((p) => p.project === m.project);
        if (rp && !rp.created) rp.plan = m.plan;
      }
      existing.updatedAt = now;
      return existing;
    }
    const rot: Rotation = {
      id: `r_${randomBytes(4).toString("hex")}`,
      fingerprint: fp,
      providerId: first.providerId,
      startedAt: now,
      updatedAt: now,
      status: "walking",
      projects: members.map((m) => ({ project: m.project, plan: m.plan, apps: m.apps.map((a) => a.name) })),
    };
    v.rotations.push(rot);
    return rot;
  });
}

/** Flip one project's plan inside a walking rotation (not once its new key exists). */
export async function setPlan(fp: string, project: string, plan: Plan): Promise<void> {
  await mutate((v) => {
    const rp = liveRotation(v, fp)?.projects.find((p) => p.project === project);
    if (!rp) return;
    if (rp.created && plan === "cutoff") throw new UserError(`${project} already has its new key — it can't be cut off now`);
    rp.plan = plan;
  });
}

export async function abandonRotation(fp: string): Promise<void> {
  await mutate((v) => {
    const r = liveRotation(v, fp);
    if (r) {
      r.status = "abandoned";
      r.updatedAt = new Date().toISOString();
    }
  });
}

async function record(fp: string, project: string, fn: (rp: RotationProject) => void): Promise<void> {
  await mutate((v) => {
    const r = liveRotation(v, fp);
    const rp = r?.projects.find((p) => p.project === project);
    if (!r || !rp) throw new UserError(`no rotation in progress for ${fp} / ${project}`);
    fn(rp);
    r.updatedAt = new Date().toISOString();
  });
}

export interface StepResult {
  ok: boolean;
  text: string;
  /** The create step needs a human: open this console, then run the step again with the clipboard. */
  console?: { url: string; name: string };
}

function oldRecord(v: Vault, fp: string, project: string): KeyRecord | undefined {
  return recordsOf(v, fp).find((k) => k.project.toLowerCase() === project.toLowerCase()) ?? recordsOf(v, fp)[0];
}

/** What the create step will do for a project: mint, reuse a key it already has, or the console. */
export function createMode(v: Vault, fp: string, project: string, providerId: string): { mode: "mint" | "console" | "own"; ownKey?: KeyRecord; why?: string } {
  const own = v.keys.find((k) => isActive(k) && k.providerId === providerId && k.project.toLowerCase() === project.toLowerCase() && k.fingerprint !== fp);
  if (own) return { mode: "own", ownKey: own };
  const p = providerById(v, providerId);
  const ability = p ? mintAbility(v, p) : "console-only";
  if (ability === "mint") return { mode: "mint" };
  return { mode: "console", why: ability === "no-admin" ? `no ${p?.name ?? providerId} admin key yet — keys admin set ${providerId} --clipboard would let it mint` : `${p?.name ?? providerId} has no key-creation API` };
}

/**
 * Run (or, with dryRun, describe) one step for one project.
 * create in console mode is two calls: without `clipboard` it opens the console
 * and returns `console`; with `clipboard` it stores what Sal copied.
 */
export async function runStep(
  fp: string,
  project: string,
  step: StepName,
  opts: { dryRun?: boolean; clipboard?: string; onTick?: (line: string) => void; apps?: string[] } = {},
): Promise<StepResult> {
  const v = readVault();
  const first = recordsOf(v, fp)[0];
  if (!first) throw new UserError(`no key with fingerprint ${fp}`);
  const provider = providerById(v, first.providerId);
  const pname = provider?.name ?? first.providerId;
  const rot = liveRotation(v, fp);
  const rp = rot?.projects.find((p) => p.project === project);
  const old = oldRecord(v, fp, project);
  const dry = Boolean(opts.dryRun);
  const fail = async (text: string): Promise<StepResult> => {
    if (!dry && rp) await record(fp, project, (x) => (x.error = text));
    return { ok: false, text };
  };

  if (step === "create") {
    const { mode, ownKey } = createMode(v, fp, project, first.providerId);
    const remote = `keys-${project}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    if (mode === "own" && ownKey) {
      if (dry) return { ok: true, text: `would use ${project}'s own ${pname} key ${ownKey.id} (fp ${ownKey.fingerprint}) — it already has one that isn't the shared value` };
      await record(fp, project, (x) => {
        x.keyId = ownKey.id;
        x.created = { at: new Date().toISOString(), note: `kept its own key ${ownKey.id}` };
        x.error = undefined;
      });
      return { ok: true, text: `✓ ${project} already has its own key ${ownKey.id} — using it` };
    }
    if (mode === "mint") {
      const adapter = provider ? adapterFor(provider) : undefined;
      if (dry) return { ok: true, text: `would mint a new ${pname} key named "${remote}" through the ${adapter?.id ?? ""} admin API and store it as ${project}'s` };
      try {
        const res = await newKey({ provider: first.providerId, project, replace: true, replaceLocalOnly: true, writeEnv: false, envFile: old?.envFile });
        if (res.kind !== "minted") return fail("the admin credential disappeared — mint not possible");
        await record(fp, project, (x) => {
          x.keyId = res.key.id;
          x.created = { at: new Date().toISOString(), note: `minted ${res.key.id} fp ${res.key.fingerprint}` };
          x.error = undefined;
        });
        return { ok: true, text: `✓ minted ${res.key.id} for ${project} · fp ${res.key.fingerprint}` };
      } catch (err) {
        return fail(`mint failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const url = provider?.consoleUrl ?? "";
    if (dry) return { ok: true, text: `would open ${url} — Sal makes a key named "${remote}" and copies it; keys reads the clipboard, stores it as ${project}'s, clears the clipboard`, console: { url, name: remote } };
    if (opts.clipboard === undefined) {
      if (url) openInChrome(url);
      return { ok: true, text: `↗ opened ${pname}: make a key named "${remote}", copy it, then confirm`, console: { url, name: remote } };
    }
    try {
      const res = await addKey({ provider: first.providerId, project, replace: true, replaceLocalOnly: true, writeEnv: false, envFile: old?.envFile }, opts.clipboard);
      if (res.key.fingerprint === fp) return fail("that's the old shared key — make a NEW one");
      await record(fp, project, (x) => {
        x.keyId = res.key.id;
        x.created = { at: new Date().toISOString(), note: `pasted ${res.key.id} fp ${res.key.fingerprint}` };
        x.error = undefined;
      });
      return { ok: true, text: `✓ stored ${res.key.id} for ${project} · fp ${res.key.fingerprint}` };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  const keyId = rp?.keyId;
  const key = keyId ? v.keys.find((k) => k.id === keyId) : undefined;

  if (step === "env") {
    const envFile = key?.envFile ?? old?.envFile ?? ".env";
    const envVar = key ? envVarFor(v, key) : old ? envVarFor(v, old) : (provider?.envVar ?? "?");
    if (dry) return { ok: true, text: `would set ${envVar} in ${project}/${envFile} to the new key (every other line kept)` };
    if (!key) return fail("no new key yet");
    try {
      const res = await writeEnv(project, false);
      const changed = res.plans.flatMap((p) => p.changes.filter((c) => c.change !== "same").map((c) => `${c.change} ${c.envVar} in ${p.file}`));
      const tracked = res.ignore.some((i) => i.tracked) ? " · ⚠ that .env is COMMITTED to git" : "";
      const note = changed.length ? changed.join(", ") : "already up to date";
      await record(fp, project, (x) => {
        x.env = { at: new Date().toISOString(), note };
        x.error = undefined;
      });
      return { ok: true, text: `✓ ${project}: ${note}${tracked}` };
    } catch (err) {
      return fail(`.env write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (step === "push") {
    const apps = rp?.apps ?? opts.apps ?? [];
    if (dry) {
      const envVar = old ? envVarFor(v, old) : (provider?.envVar ?? "?");
      return { ok: true, text: `would set ${envVar} on Drydock app${apps.length === 1 ? "" : "s"} ${apps.join(", ") || "(none mapped)"}, Apply + redeploy, and wait for the deploy to finish` };
    }
    if (!key) return fail("no new key yet");
    try {
      const res = await pushProject(project, { providerId: first.providerId, redeploy: true, onTick: opts.onTick });
      const bad = res.apps.filter((a) => a.deploy && !a.deploy.ok);
      const parts = res.apps.map((a) => {
        const sets = a.sets.filter((s) => s.change !== "same").map((s) => `${s.change} ${s.envVar}`);
        const dep = a.deploy ? (a.deploy.ok ? ` · deployed ${a.deploy.taskDef} in ${a.deploy.seconds}s` : ` · ✗ deploy: ${a.deploy.note}`) : "";
        return `${a.app}: ${sets.length ? sets.join(", ") : "already up to date"}${dep}`;
      });
      if (bad.length) return fail(parts.join(" · "));
      await record(fp, project, (x) => {
        x.pushed = { at: new Date().toISOString(), note: parts.join(" · ") };
        x.error = undefined;
      });
      return { ok: true, text: `✓ ${parts.join(" · ")}` };
    } catch (err) {
      return fail(`push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // verify
  if (dry) return { ok: true, text: `would call ${describeCheck(first.providerId)} with the new key and expect a 2xx` };
  if (!key) return fail("no new key yet");
  const r = await verifyKey(first.providerId, key.value);
  await record(fp, project, (x) => {
    x.verified = { at: new Date().toISOString(), note: r.note, ok: r.ok };
    x.error = r.ok ? undefined : `verify: ${r.note}`;
  });
  return { ok: r.ok, text: r.ok ? `✓ OK · ${r.note}${r.skipped ? " (unverified)" : ""}` : `✗ FAIL · ${r.note}` };
}

// ─── finish ──────────────────────────────────────────────────────────────────

export interface FinishPlan {
  ready: boolean;
  /** Why the old key can't be revoked yet. */
  blockers: string[];
  /** Blockers an explicit override may clear (deployed apps whose value is unknown). */
  soft: string[];
  /** How the old key goes away at the provider. */
  revoke: RemoteRevoke;
  /** Cut-off projects whose .env lines go. */
  cutoff: string[];
  /** Records marked revoked. */
  records: number;
}

/** Preconditions + what finishing would do. Re-reads Drydock so a stale cache can't green-light a revoke. */
export async function planFinish(fp: string, opts: { cacheOnly?: boolean; plans?: Record<string, Plan> } = {}): Promise<FinishPlan> {
  const v = readVault();
  const { cache, error } = await getDrydock(v, { refresh: !opts.cacheOnly, cacheOnly: opts.cacheOnly });
  const k = sharedKey(v, cache, fp, opts.plans);
  const blockers: string[] = [];
  const soft: string[] = [];
  if (error) blockers.push(`Drydock unreachable (${error}) — can't prove no deployed app still uses it`);
  for (const m of k.members) if (m.plan === "new" && !memberDone(m)) blockers.push(`${m.project} isn't done (${stepsFor(m).filter((s) => !stepDone(m.progress, s)).map((s) => STEP_LABEL[s]).join(", ")})`);
  const uses = appsUsing(cache, fp, k.provider);
  for (const u of uses) {
    if (u.how === "uses") blockers.push(`Drydock app ${u.app.name} still has the old key in ${u.vars.join(", ")}${u.app.folder ? "" : " (not mapped to a folder — keys drydock map)"}`);
    else soft.push(`Drydock app ${u.app.name} might use it (${u.vars.join(", ") || "env unreadable"}: value unknown)`);
  }
  const old = recordsOf(v, fp).find((r) => r.remoteId) ?? recordsOf(v, fp)[0];
  if (!old) throw new UserError(`no key with fingerprint ${fp}`);
  const revoke = await revokeRemote(v, old, { dryRun: true }).catch((err: unknown): RemoteRevoke => ({ remote: "skipped", note: `can't check the provider: ${err instanceof Error ? err.message : String(err)}` }));
  return {
    ready: blockers.length === 0,
    blockers,
    soft,
    revoke,
    cutoff: k.members.filter((m) => m.plan === "cutoff").map((m) => m.project),
    records: recordsOf(v, fp).filter(isActive).length,
  };
}

/** Mark every remaining record of the value revoked and take its lines out of their .env files. */
async function retireValue(fp: string): Promise<{ records: number; envRemoved: string[] }> {
  const v = readVault();
  const live = recordsOf(v, fp).filter(isActive);
  const envRemoved: string[] = [];
  for (const k of live) {
    if (k.project === "shared") continue;
    try {
      const p = resolveProject(k.project);
      if (p.dir && removeFromEnv(join(p.dir, k.envFile), envVarFor(v, k), k.value)) envRemoved.push(k.project);
    } catch {
      /* folder gone */
    }
  }
  const at = new Date().toISOString();
  await mutate((vault) => {
    for (const k of vault.keys) if (k.fingerprint === fp && isActive(k)) k.revokedAt = at;
  });
  return { records: live.length, envRemoved };
}

export interface FinishResult {
  done: boolean;
  text: string;
  /** Console-only revoke: open this, delete the key, then call finish again with consoleDone. */
  console?: { url: string; hint: string };
}

/**
 * Revoke the old shared key. With an adapter: at the provider, then locally.
 * Without: the first call returns the console page + which key to delete; the
 * second call (consoleDone) does the local half once Sal says it's gone.
 */
export async function finishRotation(fp: string, opts: { consoleDone?: boolean; override?: boolean } = {}): Promise<FinishResult> {
  const plan = await planFinish(fp);
  if (!plan.ready) throw new UserError(`not yet: ${plan.blockers.join("; ")}`);
  if (plan.soft.length && !opts.override) throw new UserError(`${plan.soft.join("; ")} — override to revoke anyway`);
  const v = readVault();
  let remote: "revoked" | "console" = "revoked";
  let note: string;
  if (plan.revoke.console) {
    if (!opts.consoleDone) {
      openInChrome(plan.revoke.console.url);
      return { done: false, text: `↗ opened ${plan.revoke.console.url} — delete the key ${plan.revoke.console.hint}, then confirm`, console: plan.revoke.console };
    }
    remote = "console";
    note = `deleted in the console (${plan.revoke.console.hint})`;
  } else {
    const old = recordsOf(v, fp).find((r) => r.remoteId) ?? recordsOf(v, fp)[0];
    if (!old) throw new UserError(`no key with fingerprint ${fp}`);
    const r = await revokeRemote(v, old);
    note = r.note;
  }
  const retired = await retireValue(fp);
  await mutate((vault) => {
    const r = liveRotation(vault, fp);
    if (!r) return;
    r.status = "finished";
    r.revoked = { at: new Date().toISOString(), note, remote };
    r.updatedAt = r.revoked.at;
  });
  return { done: true, text: `✓ old key ${note} · ${retired.records} records retired · .env lines removed in ${retired.envRemoved.length ? retired.envRemoved.join(", ") : "none"}` };
}

// ─── batch revoke of dead keys ───────────────────────────────────────────────

export function deadKeys(all: SharedKey[]): SharedKey[] {
  return all.filter((k) => !k.rotation && (k.dead || k.blockedBy.length > 0));
}

/** Revoke one dead value everywhere. Console-only providers: first call opens the page, second (consoleDone) retires it. */
export async function revokeDead(fp: string, opts: { consoleDone?: boolean; override?: boolean; dryRun?: boolean } = {}): Promise<FinishResult> {
  const v = readVault();
  const { cache } = await getDrydock(v, { cacheOnly: opts.dryRun });
  const k = sharedKey(v, cache, fp);
  if (!k.dead && !k.blockedBy.length) throw new UserError(`${fp} isn't dead — an active or deployed project uses it; rotate it instead`);
  if (k.blockedBy.length && !opts.override) throw new UserError(`${fp}: ${k.blockedBy.join("; ")} — override to revoke anyway`);
  const old = recordsOf(v, fp).find((r) => r.remoteId) ?? recordsOf(v, fp)[0];
  if (!old) throw new UserError(`no key with fingerprint ${fp}`);
  const projects = k.members.map((m) => m.project);
  if (opts.dryRun) {
    const r = await revokeRemote(v, old, { dryRun: true });
    return { done: false, text: `${r.console ? `console: ${r.console.url} — delete the key ${r.console.hint}` : r.note}; would retire ${recordsOf(v, fp).filter(isActive).length} records and drop the line from ${projects.length} .env files` };
  }
  const r = opts.consoleDone ? null : await revokeRemote(v, old);
  if (r?.console) {
    openInChrome(r.console.url);
    return { done: false, text: `↗ opened ${r.console.url} — delete the key ${r.console.hint}, then confirm`, console: r.console };
  }
  const note = r ? r.note : `deleted in the console (${consoleHint(old)})`;
  const retired = await retireValue(fp);
  return { done: true, text: `✓ ${k.providerId} fp ${fp}: ${note} · ${retired.records} records retired` };
}
