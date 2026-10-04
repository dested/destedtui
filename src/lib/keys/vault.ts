// The key vault: one DPAPI-encrypted JSON document at ~/.destedtui/keys/vault.bin.
//
// Every read decrypts and zod-validates; every write goes through `mutate`, which
// takes a lock file, re-reads, applies the change, writes a temp file and renames
// it over the vault, keeping the previous five versions as vault.bin.1..5.
// Values never leave this module except through explicit accessors — callers that
// display anything use `fingerprint`.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG_DIR } from "../config.ts";
import { protect, unprotect } from "./win32.ts";
import { BUILTIN_PROVIDERS } from "./providers.ts";
import { UserError } from "./errors.ts";

export const VAULT_DIR = process.env.KEYS_VAULT_DIR || join(CONFIG_DIR, "keys");
export const VAULT_PATH = join(VAULT_DIR, "vault.bin");
const LOCK_PATH = join(VAULT_DIR, "vault.lock");
const KEEP_VERSIONS = 5;
const LOCK_STALE_MS = 15_000;

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, . _ -");
const envVar = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a valid env var name");

export const providerSchema = z.object({
  id: slug,
  name: z.string().min(1),
  envVar,
  /** Other names the same key goes by in .env files (VITE_*, legacy names). Import matches these. */
  aliases: z.array(envVar).default([]),
  /** Value prefixes that identify this provider's keys (`sk-ant-`, `xai-`). Import matches these. */
  prefixes: z.array(z.string()).default([]),
  consoleUrl: z.string().url(),
  /** Mint adapter id (lib/keys/adapters); absent = console-only. */
  mint: z.string().optional(),
  builtin: z.boolean().default(false),
});
export type Provider = z.infer<typeof providerSchema>;

export const keySchema = z.object({
  id: z.string().min(1),
  providerId: slug,
  /** Folder slug under the projects root, or "shared". */
  project: z.string().min(1),
  label: z.string(),
  value: z.string().min(1),
  fingerprint: z.string(),
  createdAt: z.string(),
  source: z.enum(["minted", "pasted", "imported"]),
  /** Provider-side id, needed to revoke remotely. */
  remoteId: z.string().optional(),
  revokedAt: z.string().optional(),
  /** Which file inside the project it lives in (default `.env`). */
  envFile: z.string().default(".env"),
  /** The var name in that file when it isn't the provider's envVar (e.g. VITE_OPENAI_API_KEY). */
  envVar: envVar.optional(),
});
export type KeyRecord = z.infer<typeof keySchema>;

export const adminSchema = z.object({
  providerId: slug,
  value: z.string().min(1),
  fingerprint: z.string(),
  createdAt: z.string(),
  /** Adapter-specific settings (OpenAI project id, ElevenLabs service account, xAI team id). */
  meta: z.record(z.string(), z.string()).default({}),
});
export type AdminCredential = z.infer<typeof adminSchema>;

const stepSchema = z.object({ at: z.string(), note: z.string().default("") });

/** One project inside a rotation: get a new key, or be cut off when the old one is revoked. */
export const rotationProjectSchema = z.object({
  project: z.string().min(1),
  plan: z.enum(["new", "cutoff"]),
  /** Drydock apps deployed from this folder (copied in when the walk starts). */
  apps: z.array(z.string()).default([]),
  /** Set once the new key exists — the vault key id. */
  keyId: z.string().optional(),
  created: stepSchema.optional(),
  env: stepSchema.optional(),
  pushed: stepSchema.optional(),
  verified: stepSchema.extend({ ok: z.boolean() }).optional(),
  /** Last failure on this project, cleared by the next success. */
  error: z.string().optional(),
});
export type RotationProject = z.infer<typeof rotationProjectSchema>;

/**
 * A rotation in progress: replace one shared key with one key per project.
 * Lives in the vault so quitting halfway and running `keys rotate` again resumes.
 */
export const rotationSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  providerId: slug,
  startedAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["walking", "finished", "abandoned"]),
  projects: z.array(rotationProjectSchema),
  /** What happened to the old key at the provider once the walk finished. */
  revoked: stepSchema.extend({ remote: z.enum(["revoked", "console"]) }).optional(),
});
export type Rotation = z.infer<typeof rotationSchema>;

export const drydockPrefsSchema = z.object({
  /** Drydock app → folder under the projects root ("-" = not a local project). Wins over repo/name matching. */
  overrides: z.record(z.string(), z.string()).default({}),
});

export const vaultSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerSchema),
  keys: z.array(keySchema),
  admin: z.array(adminSchema),
  drydock: drydockPrefsSchema.default({ overrides: {} }),
  rotations: z.array(rotationSchema).default([]),
});
export type Vault = z.infer<typeof vaultSchema>;

/** sha256 prefix — what every screen and list shows instead of the value. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function newKeyId(): string {
  return `k_${randomBytes(4).toString("hex")}`;
}

function emptyVault(): Vault {
  return { version: 1, providers: BUILTIN_PROVIDERS.map((p) => ({ ...p })), keys: [], admin: [], drydock: { overrides: {} }, rotations: [] };
}

/**
 * Built-ins are code, not data: a provider row marked builtin is refreshed from
 * BUILTIN_PROVIDERS on every load (so a new alias or adapter reaches an existing
 * vault), and a built-in added in a later version appears.
 */
function withBuiltins(v: Vault): Vault {
  const custom = v.providers.filter((p) => !p.builtin && !BUILTIN_PROVIDERS.some((b) => b.id === p.id));
  return { ...v, providers: [...BUILTIN_PROVIDERS.map((p) => ({ ...p })), ...custom] };
}

export function readVault(): Vault {
  if (!existsSync(VAULT_PATH)) return emptyVault();
  const plain = unprotect(new Uint8Array(readFileSync(VAULT_PATH)));
  const raw: unknown = JSON.parse(new TextDecoder().decode(plain));
  const parsed = vaultSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`vault.bin failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return withBuiltins(parsed.data);
}

function rotateBackups(): void {
  if (!existsSync(VAULT_PATH)) return;
  for (let n = KEEP_VERSIONS - 1; n >= 1; n--) {
    const from = `${VAULT_PATH}.${n}`;
    if (existsSync(from)) renameSync(from, `${VAULT_PATH}.${n + 1}`);
  }
  copyFileSync(VAULT_PATH, `${VAULT_PATH}.1`);
}

function writeVault(v: Vault): void {
  const checked = vaultSchema.parse(v);
  mkdirSync(VAULT_DIR, { recursive: true });
  const tmp = `${VAULT_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, protect(new TextEncoder().encode(JSON.stringify(checked))));
  rotateBackups();
  renameSync(tmp, VAULT_PATH);
}

async function lock(): Promise<() => void> {
  mkdirSync(VAULT_DIR, { recursive: true });
  for (let i = 0; i < 100; i++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(LOCK_PATH, { force: true });
    } catch {
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) rmSync(LOCK_PATH, { force: true });
      } catch {
        /* vanished between the two calls — retry */
      }
      await Bun.sleep(50);
    }
  }
  throw new Error(`vault is locked by another process (${LOCK_PATH})`);
}

/** Read-modify-write under the lock. Whatever `fn` returns is passed through. */
export async function mutate<R>(fn: (v: Vault) => R | Promise<R>): Promise<R> {
  const release = await lock();
  try {
    const v = readVault();
    const result = await fn(v);
    writeVault(v);
    return result;
  } finally {
    release();
  }
}

export function isActive(k: KeyRecord): boolean {
  return k.revokedAt === undefined;
}

export function providerById(v: Vault, id: string): Provider | undefined {
  return v.providers.find((p) => p.id === id);
}

/** The env var a key is written under. */
export function envVarFor(v: Vault, k: KeyRecord): string {
  return k.envVar ?? providerById(v, k.providerId)?.envVar ?? `${k.providerId.toUpperCase()}_API_KEY`;
}

/** Find by exact id, or by a unique id prefix (`k_3f` is enough when it's unambiguous). */
export function findKey(v: Vault, id: string): KeyRecord {
  const exact = v.keys.find((k) => k.id === id);
  if (exact) return exact;
  const hits = v.keys.filter((k) => k.id.startsWith(id));
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1) throw new UserError(`"${id}" matches ${hits.length} keys — use more of the id`);
  throw new UserError(`no key with id "${id}" — see keys list`);
}

export interface ReuseGroup {
  fingerprint: string;
  providerId: string;
  projects: string[];
  keyIds: string[];
}

/** Active keys whose value appears under more than one project — the mess to untangle. */
export function reuseGroups(v: Vault): ReuseGroup[] {
  const by = new Map<string, ReuseGroup>();
  for (const k of v.keys) {
    if (!isActive(k)) continue;
    const g = by.get(k.fingerprint) ?? { fingerprint: k.fingerprint, providerId: k.providerId, projects: [], keyIds: [] };
    if (!g.projects.includes(k.project)) g.projects.push(k.project);
    g.keyIds.push(k.id);
    by.set(k.fingerprint, g);
  }
  return [...by.values()].filter((g) => g.projects.length > 1).sort((a, b) => b.projects.length - a.projects.length);
}
