// Usage cache: ~/.destedtui/keys/usage.json. Plain JSON — it holds no secrets,
// only provider-side key ids and names, vault key ids, and numbers.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { VAULT_DIR } from "../vault.ts";

export const USAGE_PATH = join(VAULT_DIR, "usage.json");
/** How old the cache may be before a read triggers a refetch. */
export const STALE_MS = 15 * 60_000;

/** One provider-side key (or null = usage no key is credited with) on one UTC day. */
export const usageRowSchema = z.object({
  remoteKeyId: z.string().nullable(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  usd: z.number().optional(),
  units: z.number().optional(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

/** Providers that only report rolling windows for a key (OpenRouter), not a day series. */
export const windowRowSchema = z.object({
  remoteKeyId: z.string(),
  today: z.number(),
  /** Week to date (OpenRouter's UTC Monday–Sunday week). */
  week: z.number(),
});
export type WindowRow = z.infer<typeof windowRowSchema>;

export const remoteKeySchema = z.object({
  remoteKeyId: z.string(),
  name: z.string().optional(),
  /** Vault keys this provider-side key was matched to (same value ⇒ possibly several records). */
  vaultKeyIds: z.array(z.string()),
  /** How the match was made — shown so a guess never passes for a fact. */
  matchedBy: z.enum(["redacted-value", "key-hint", "key-id", "name", "value"]).optional(),
  lastUsedAt: z.string().optional(),
});
export type RemoteKey = z.infer<typeof remoteKeySchema>;

export const providerUsageSchema = z.object({
  providerId: z.string(),
  status: z.enum(["ok", "needs-admin", "no-api", "error"]),
  /** What the provider can tell us: per key, or only for the whole account. */
  scope: z.enum(["per-key", "account", "none"]),
  message: z.string().optional(),
  /** Unit for `units` when the provider reports no money (e.g. "credits", "tokens"). */
  unit: z.string().optional(),
  /** True when `usd` is allocated from account cost by token share rather than reported per key. */
  allocated: z.boolean().default(false),
  fetchedAt: z.string(),
  rows: z.array(usageRowSchema).default([]),
  windows: z.array(windowRowSchema).default([]),
  remoteKeys: z.array(remoteKeySchema).default([]),
});
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const usageCacheSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.string(),
  days: z.number().int().positive(),
  providers: z.array(providerUsageSchema),
});
export type UsageCache = z.infer<typeof usageCacheSchema>;

export function readUsageCache(): UsageCache | null {
  if (!existsSync(USAGE_PATH)) return null;
  try {
    const parsed = usageCacheSchema.safeParse(JSON.parse(readFileSync(USAGE_PATH, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeUsageCache(cache: UsageCache): void {
  mkdirSync(VAULT_DIR, { recursive: true });
  const tmp = `${USAGE_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(usageCacheSchema.parse(cache), null, 2));
  renameSync(tmp, USAGE_PATH);
}

export function isStale(cache: UsageCache | null, days: number, now = Date.now()): boolean {
  return !cache || cache.days < days || now - Date.parse(cache.fetchedAt) > STALE_MS;
}

/** UTC calendar day of a timestamp. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Midnight UTC, `daysBack` days before today. */
export function utcDayStart(now: number, daysBack: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysBack);
}
