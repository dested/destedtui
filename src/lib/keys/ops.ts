// Every vault operation the CLI and the screen share. Nothing here prints:
// results come back as data with fingerprints, never values.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { projectsRoot } from "../projects.ts";
import { openInChrome } from "../run.ts";
import { ADAPTERS, type AdminInput, type MintAdapter } from "./adapters/index.ts";
import { ProviderError, UserError } from "./errors.ts";
import { ensureIgnored, removeFromEnv, upsertEnv, type EnvPlan, type IgnoreResult } from "./envfile.ts";
import { scanEnvFiles, type Finding } from "./importer.ts";
import { PROVIDER_ID_ALIASES } from "./providers.ts";
import {
  envVarFor,
  findKey,
  fingerprint,
  isActive,
  mutate,
  newKeyId,
  providerById,
  providerSchema,
  readVault,
  reuseGroups,
  type KeyRecord,
  type Provider,
  type ReuseGroup,
  type Vault,
} from "./vault.ts";

export const SHARED = "shared";

// ─── projects ────────────────────────────────────────────────────────────────

export interface ProjectRef {
  /** The folder name as it is on disk (or "shared"). */
  slug: string;
  /** Absolute folder, null for "shared". */
  dir: string | null;
}

/** Resolve a project name to its folder under the projects root, case-insensitively. */
export function resolveProject(name: string): ProjectRef {
  if (name.toLowerCase() === SHARED) return { slug: SHARED, dir: null };
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new UserError(`project must be a folder name under ${projectsRoot()}, got "${name}"`);
  const root = projectsRoot();
  let hit: string | undefined;
  try {
    hit = readdirSync(root).find((n) => n.toLowerCase() === name.toLowerCase());
  } catch {
    throw new UserError(`can't read the projects root ${root}`);
  }
  if (!hit) throw new UserError(`no folder "${name}" in ${root} (use "${SHARED}" for a key that belongs to no project)`);
  const dir = join(root, hit);
  if (!statSync(dir).isDirectory()) throw new UserError(`${dir} is not a folder`);
  return { slug: hit, dir };
}

/** The project the cwd is inside (first path segment under the projects root), if any. */
export function projectFromCwd(cwd: string): string | undefined {
  const rel = relative(projectsRoot(), cwd);
  if (!rel || rel.startsWith("..") || /^[a-zA-Z]:/.test(rel)) return undefined;
  return rel.split(sep)[0] || undefined;
}

function sameProject(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ─── providers / admin ───────────────────────────────────────────────────────

export function getProvider(v: Vault, id: string): Provider {
  const lower = id.toLowerCase();
  const p = providerById(v, PROVIDER_ID_ALIASES[lower] ?? lower);
  if (!p) throw new UserError(`unknown provider "${id}" — keys providers lists them; keys provider add makes one`);
  return p;
}

export function adapterFor(p: Provider): MintAdapter | undefined {
  return p.mint ? ADAPTERS.get(p.mint) : undefined;
}

export type AdminSource = "vault" | "env";

/** The admin credential for a provider: the vault's, else the adapter's user env var (OPENAI_ADMIN_KEY). */
export function adminFor(v: Vault, p: Provider): { admin: AdminInput; source: AdminSource } | null {
  const stored = v.admin.find((a) => a.providerId === p.id);
  if (stored) return { admin: { value: stored.value, meta: stored.meta }, source: "vault" };
  const envName = adapterFor(p)?.adminEnvVar;
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv) return { admin: { value: fromEnv, meta: {} }, source: "env" };
  return null;
}

export type MintAbility = "mint" | "no-admin" | "console-only";

/** Whether `keys new` can make a key for this provider right now. */
export function mintAbility(v: Vault, p: Provider): MintAbility {
  const adapter = adapterFor(p);
  if (!adapter?.mint) return "console-only";
  return adminFor(v, p) ? "mint" : "no-admin";
}

export async function addProvider(input: { id: string; name: string; envVar: string; consoleUrl: string; aliases?: string[] }): Promise<Provider> {
  const parsed = providerSchema.safeParse({ ...input, id: input.id.toLowerCase(), aliases: input.aliases ?? [], prefixes: [], builtin: false });
  if (!parsed.success) throw new UserError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const provider = parsed.data;
  return mutate((v) => {
    if (providerById(v, provider.id)) throw new UserError(`provider "${provider.id}" already exists`);
    v.providers.push(provider);
    return provider;
  });
}

export async function removeProvider(id: string): Promise<void> {
  await mutate((v) => {
    const p = getProvider(v, id);
    if (p.builtin) throw new UserError(`${p.id} is built in`);
    if (v.keys.some((k) => k.providerId === p.id && isActive(k))) throw new UserError(`${p.id} still has active keys — revoke them first`);
    v.providers = v.providers.filter((x) => x.id !== p.id);
  });
}

export async function setAdmin(providerId: string, value: string, meta: Record<string, string>): Promise<{ fingerprint: string }> {
  const clean = value.trim();
  if (clean.length < 8) throw new UserError("that doesn't look like a credential (too short)");
  return mutate((v) => {
    const p = getProvider(v, providerId);
    const fp = fingerprint(clean);
    v.admin = v.admin.filter((a) => a.providerId !== p.id);
    v.admin.push({ providerId: p.id, value: clean, fingerprint: fp, createdAt: new Date().toISOString(), meta });
    return { fingerprint: fp };
  });
}

export async function removeAdmin(providerId: string): Promise<boolean> {
  return mutate((v) => {
    const before = v.admin.length;
    v.admin = v.admin.filter((a) => a.providerId !== providerId.toLowerCase());
    return v.admin.length < before;
  });
}

// ─── keys ────────────────────────────────────────────────────────────────────

export interface KeyView {
  id: string;
  providerId: string;
  project: string;
  label: string;
  fingerprint: string;
  createdAt: string;
  source: KeyRecord["source"];
  remoteId?: string;
  revokedAt?: string;
  envFile: string;
  envVar: string;
  /** Other projects holding the same value (active keys only). */
  sharedWith: string[];
}

/** The value-free shape every list, screen and --json output uses. */
export function viewKeys(v: Vault, opts: { project?: string; provider?: string; all?: boolean } = {}): KeyView[] {
  const groups = new Map(reuseGroups(v).map((g) => [g.fingerprint, g]));
  const provider = opts.provider?.toLowerCase();
  const providerId = provider && (PROVIDER_ID_ALIASES[provider] ?? provider);
  return v.keys
    .filter((k) => opts.all || isActive(k))
    .filter((k) => !opts.project || sameProject(k.project, opts.project))
    .filter((k) => !providerId || k.providerId === providerId)
    .map((k) => ({
      id: k.id,
      providerId: k.providerId,
      project: k.project,
      label: k.label,
      fingerprint: k.fingerprint,
      createdAt: k.createdAt,
      source: k.source,
      remoteId: k.remoteId,
      revokedAt: k.revokedAt,
      envFile: k.envFile,
      envVar: envVarFor(v, k),
      sharedWith: isActive(k) ? (groups.get(k.fingerprint)?.projects.filter((p) => !sameProject(p, k.project)) ?? []) : [],
    }))
    .sort((a, b) => a.project.localeCompare(b.project) || a.providerId.localeCompare(b.providerId));
}

function activeFor(v: Vault, providerId: string, project: string): KeyRecord | undefined {
  return v.keys.find((k) => isActive(k) && k.providerId === providerId && sameProject(k.project, project));
}

export interface StoreOptions {
  provider: string;
  project: string;
  label?: string;
  envFile?: string;
  /** Rotate out the project's current key for this provider instead of refusing. */
  replace?: boolean;
  /** Write the project's .env afterwards (default true). */
  writeEnv?: boolean;
  /** With replace: retire the old record locally only, never at the provider (a rotation revokes it at the end). */
  replaceLocalOnly?: boolean;
}

export interface StoreResult {
  key: KeyView;
  /** The key this one replaced, and what happened to it. */
  replaced?: RevokeResult;
  env?: EnvWriteResult;
  note?: string;
}

/** Refuse a second active key for (provider, project) unless --replace. */
function assertSlot(v: Vault, provider: Provider, project: string, replace: boolean | undefined): KeyRecord | undefined {
  const current = activeFor(v, provider.id, project);
  if (current && !replace) {
    throw new UserError(
      `${project} already has an active ${provider.name} key (${current.id}, fp ${current.fingerprint}) — one key per project per provider. Pass --replace to rotate it.`,
    );
  }
  return current;
}

async function store(
  opts: StoreOptions,
  value: string,
  source: KeyRecord["source"],
  remoteId: string | undefined,
  note: string | undefined,
): Promise<StoreResult> {
  const project = resolveProject(opts.project);
  const stored = await mutate((v) => {
    const provider = getProvider(v, opts.provider);
    const current = assertSlot(v, provider, project.slug, opts.replace);
    const fp = fingerprint(value);
    const record: KeyRecord = {
      id: newKeyId(),
      providerId: provider.id,
      project: project.slug,
      label: opts.label ?? "",
      value,
      fingerprint: fp,
      createdAt: new Date().toISOString(),
      source,
      remoteId,
      envFile: opts.envFile ?? current?.envFile ?? ".env",
      envVar: current?.envVar,
    };
    v.keys.push(record);
    return { id: record.id, previous: current?.id };
  });
  const result: StoreResult = { key: mustView(stored.id), note };
  if (stored.previous && opts.replaceLocalOnly) {
    result.replaced = await revokeKey(stored.previous, { keepEnv: true, localOnly: true });
  } else if (stored.previous) {
    try {
      result.replaced = await revokeKey(stored.previous, { keepEnv: true });
    } catch (err) {
      // The new key is already stored; a provider hiccup must not leave two active keys.
      result.replaced = await revokeKey(stored.previous, { keepEnv: true, localOnly: true });
      result.replaced.remoteNote = `remote revoke failed (${err instanceof Error ? err.message : String(err)}) — delete it in the console`;
    }
  }
  if (opts.writeEnv !== false && project.dir) result.env = await writeEnv(project.slug, false);
  result.key = mustView(stored.id);
  return result;
}

function mustView(id: string): KeyView {
  const v = readVault();
  const hit = viewKeys(v, { all: true }).find((k) => k.id === id);
  if (!hit) throw new Error(`key ${id} vanished from the vault`);
  return hit;
}

export type NewResult =
  | ({ kind: "minted" } & StoreResult)
  | { kind: "console"; provider: Provider; url: string; reason: "console-only" | "no-admin"; adminHint?: string };

/**
 * `keys new`: mint through the adapter when there is one and an admin credential;
 * otherwise open the console page and say what to do next.
 */
export async function newKey(opts: StoreOptions & { openConsole?: boolean }): Promise<NewResult> {
  const v = readVault();
  const provider = getProvider(v, opts.provider);
  const project = resolveProject(opts.project);
  assertSlot(v, provider, project.slug, opts.replace);
  const adapter = adapterFor(provider);
  const admin = adminFor(v, provider);
  if (!adapter?.mint || !admin) {
    if (opts.openConsole !== false) openInChrome(provider.consoleUrl);
    const reason = adapter?.mint ? "no-admin" : "console-only";
    const adminHint =
      reason === "no-admin" && adapter
        ? `make a ${adapter.adminKind} at ${adapter.adminConsoleUrl}, copy it, then: keys admin set ${provider.id} --clipboard${adapter.adminEnvVar ? ` (or set ${adapter.adminEnvVar})` : ""}`
        : undefined;
    return { kind: "console", provider, url: provider.consoleUrl, reason, adminHint };
  }
  const minted = await adapter.mint(admin.admin, { project: project.slug, label: opts.label ?? "" });
  try {
    const res = await store(opts, minted.value, "minted", minted.remoteId, minted.note);
    return { kind: "minted", ...res };
  } catch (err) {
    // Stored nowhere means nobody can ever revoke it: undo the mint before failing.
    if (adapter.revoke) await adapter.revoke(admin.admin, minted.remoteId).catch(() => undefined);
    throw err;
  }
}

/** `keys add`: a key made somewhere else (console), arriving via clipboard or stdin. */
export async function addKey(opts: StoreOptions, rawValue: string): Promise<StoreResult> {
  const value = rawValue.trim();
  if (!value) throw new UserError("no key found (clipboard/stdin was empty)");
  if (/\s/.test(value)) throw new UserError("that has whitespace in it — copy just the key");
  if (value.length < 16) throw new UserError("that's too short to be an API key — copy the whole key");
  const v = readVault();
  const dupe = v.keys.find((k) => isActive(k) && k.value === value);
  if (dupe && !sameProject(dupe.project, opts.project)) {
    throw new UserError(`that key is already ${dupe.project}'s (${dupe.id}) — one key per project; make a new one`);
  }
  let remoteId: string | undefined;
  const provider = getProvider(v, opts.provider);
  const adapter = adapterFor(provider);
  const admin = adminFor(v, provider);
  if (adapter?.locate && admin) remoteId = await adapter.locate(admin.admin, value).catch(() => undefined);
  return store(opts, value, "pasted", remoteId, undefined);
}

// ─── .env ────────────────────────────────────────────────────────────────────

export interface EnvWriteResult {
  project: string;
  plans: EnvPlan[];
  ignore: (IgnoreResult & { file: string })[];
}

/** Write a project's active keys into its env file(s). Values stay in the file; the result carries var names only. */
export async function writeEnv(projectName: string, dryRun: boolean): Promise<EnvWriteResult> {
  const project = resolveProject(projectName);
  if (!project.dir) throw new UserError(`"${SHARED}" keys have no project folder to write a .env into`);
  const v = readVault();
  const keys = v.keys.filter((k) => isActive(k) && sameProject(k.project, project.slug));
  const byFile = new Map<string, Record<string, string>>();
  for (const k of keys) {
    const vars = byFile.get(k.envFile) ?? {};
    vars[envVarFor(v, k)] = k.value;
    byFile.set(k.envFile, vars);
  }
  const result: EnvWriteResult = { project: project.slug, plans: [], ignore: [] };
  for (const [file, vars] of byFile) {
    const abs = join(project.dir, file);
    if (!dryRun) result.ignore.push({ file, ...ensureIgnored(project.dir, file) });
    result.plans.push(upsertEnv(abs, vars, dryRun));
  }
  return result;
}

/** Name → value for a project's active keys. Only for `keys values` (Use-Keys); never displayed. */
export function projectValues(projectName: string): Record<string, string> {
  const project = resolveProject(projectName);
  const v = readVault();
  const out: Record<string, string> = {};
  for (const k of v.keys) if (isActive(k) && sameProject(k.project, project.slug)) out[envVarFor(v, k)] = k.value;
  return out;
}

// ─── revoke ──────────────────────────────────────────────────────────────────

export interface RevokeResult {
  id: string;
  fingerprint: string;
  project: string;
  /** What happened on the provider's side. */
  remote: "revoked" | "skipped";
  remoteNote: string;
  envRemoved: boolean;
}

/**
 * Revoke on the provider when we can and it's safe — never when the same value is
 * still active in another project (that would break them) — then mark it locally
 * and take its line out of the project's env file.
 */
/** How to find a key in a provider console without its value: the name it was made under, else its last 4 characters. */
export function consoleHint(k: KeyRecord): string {
  const name = k.source === "minted" ? `named "keys-${k.project}${k.label ? `-${k.label}` : ""}"` : "";
  const tail = `ending …${k.value.slice(-4)}`;
  return name ? `${name} (${tail})` : tail;
}

export interface RemoteRevoke {
  remote: "revoked" | "skipped";
  note: string;
  /** Set when a human has to delete it: where, and how to recognise it. */
  console?: { url: string; hint: string };
}

/**
 * Revoke one key value at its provider: through the adapter with its remote id
 * (or one located from the value), else say exactly where and what to delete.
 * A ProviderError propagates — callers leave the vault untouched when it does.
 */
export async function revokeRemote(v: Vault, key: KeyRecord, opts: { dryRun?: boolean } = {}): Promise<RemoteRevoke> {
  const provider = providerById(v, key.providerId);
  const adapter = provider ? adapterFor(provider) : undefined;
  const admin = provider ? adminFor(v, provider) : null;
  const url = provider?.consoleUrl ?? "the provider console";
  const manual = (why: string): RemoteRevoke => ({ remote: "skipped", note: `${why} — delete the key ${consoleHint(key)} at ${url}`, console: { url, hint: consoleHint(key) } });
  if (!adapter?.revoke) return manual(`${provider?.name ?? key.providerId} has no revoke API`);
  if (!admin) return manual(`no admin credential for ${key.providerId}`);
  let remoteId = key.remoteId;
  if (!remoteId && adapter.locate) remoteId = await adapter.locate(admin.admin, key.value);
  if (!remoteId) return manual(`don't know its id on ${provider?.name}`);
  if (opts.dryRun) return { remote: "revoked", note: `would revoke ${remoteId} on ${provider?.name} through its admin API` };
  await adapter.revoke(admin.admin, remoteId);
  return { remote: "revoked", note: `revoked on ${provider?.name}` };
}

export async function revokeKey(id: string, opts: { localOnly?: boolean; keepEnv?: boolean } = {}): Promise<RevokeResult> {
  const v = readVault();
  const key = findKey(v, id);
  if (!isActive(key)) throw new UserError(`${key.id} was already revoked at ${key.revokedAt}`);
  const sharers = v.keys.filter((k) => k.id !== key.id && isActive(k) && k.fingerprint === key.fingerprint).map((k) => k.project);
  let remote: RevokeResult["remote"] = "skipped";
  let remoteNote: string;
  if (opts.localOnly) remoteNote = "--local-only";
  else if (sharers.length > 0) remoteNote = `same value still active in ${sharers.join(", ")} — revoke those first or rotate it in the console`;
  else {
    const r = await revokeRemote(v, key); // a ProviderError here leaves the vault untouched
    remote = r.remote;
    remoteNote = r.note;
  }
  await mutate((vault) => {
    const k = vault.keys.find((x) => x.id === key.id);
    if (k) k.revokedAt = new Date().toISOString();
  });
  let envRemoved = false;
  if (!opts.keepEnv && key.project !== SHARED) {
    try {
      const project = resolveProject(key.project);
      if (project.dir) envRemoved = removeFromEnv(join(project.dir, key.envFile), envVarFor(v, key), key.value);
    } catch {
      /* project folder gone — nothing to clean */
    }
  }
  return { id: key.id, fingerprint: key.fingerprint, project: key.project, remote, remoteNote, envRemoved };
}

// ─── import ──────────────────────────────────────────────────────────────────

export interface ImportReport {
  filesScanned: number;
  found: number;
  imported: { id: string; project: string; providerId: string; fingerprint: string; file: string; envVar: string }[];
  known: number;
  /** A second, different key for the same provider in one project — not stored (one key per project per provider). */
  conflicts: { project: string; providerId: string; fingerprint: string; file: string; envVar: string; kept: string }[];
  reuse: ReuseGroup[];
}

export async function importKeys(opts: { root?: string; dryRun?: boolean } = {}): Promise<ImportReport> {
  const root = opts.root ?? projectsRoot();
  if (!existsSync(root)) throw new UserError(`no such folder: ${root}`);
  const apply = (v: Vault, scan: { findings: Finding[]; filesScanned: number }): ImportReport => {
    const report: ImportReport = { filesScanned: scan.filesScanned, found: scan.findings.length, imported: [], known: 0, conflicts: [], reuse: [] };
    for (const f of scan.findings) {
      const current = activeFor(v, f.providerId, f.project);
      if (current?.fingerprint === f.fingerprint) {
        report.known++;
        continue;
      }
      if (current) {
        if (report.conflicts.some((c) => c.project === f.project && c.providerId === f.providerId && c.fingerprint === f.fingerprint)) continue;
        report.conflicts.push({ project: f.project, providerId: f.providerId, fingerprint: f.fingerprint, file: f.file, envVar: f.envVar, kept: current.id });
        continue;
      }
      const provider = providerById(v, f.providerId);
      const record: KeyRecord = {
        id: newKeyId(),
        providerId: f.providerId,
        project: f.project,
        label: "imported",
        value: f.value,
        fingerprint: f.fingerprint,
        createdAt: new Date().toISOString(),
        source: "imported",
        envFile: f.file,
        envVar: provider && provider.envVar === f.envVar ? undefined : f.envVar,
      };
      v.keys.push(record);
      report.imported.push({ id: record.id, project: f.project, providerId: f.providerId, fingerprint: f.fingerprint, file: f.file, envVar: f.envVar });
    }
    report.reuse = reuseGroups(v);
    return report;
  };
  if (opts.dryRun) {
    const v = readVault();
    return apply(v, scanEnvFiles(root, v.providers));
  }
  return mutate((v) => apply(v, scanEnvFiles(root, v.providers)));
}

export { ProviderError, UserError };
