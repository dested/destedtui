import type { AdminInput } from "../adapters/types.ts";
import type { KeyRecord, Provider, Vault } from "../vault.ts";
import type { ProviderUsage } from "./cache.ts";

export interface UsageContext {
  vault: Vault;
  provider: Provider;
  /** Admin credential from the vault or its env var, if any. */
  admin: AdminInput | null;
  /** Whole UTC days to fetch, today included. */
  days: number;
  now: number;
}

/** What a fetcher returns; `fetchUsage` stamps providerId/fetchedAt. */
export type UsageResult = Omit<ProviderUsage, "providerId" | "fetchedAt">;

/**
 * One provider's usage API. Like mint adapters: one file per provider plus a line
 * in ./index.ts. A provider with no fetcher shows "no usage API".
 */
export interface UsageFetcher {
  id: string;
  fetch: (ctx: UsageContext) => Promise<UsageResult>;
}

export function keysOf(ctx: UsageContext): KeyRecord[] {
  return ctx.vault.keys.filter((k) => k.providerId === ctx.provider.id);
}

/**
 * Vault keys a redacted value could be. Handles `sk-proj-****abcd` (OpenAI) and
 * `sk-ant-api03-R2D...igAA` (Anthropic). Several records with the SAME value are one
 * match; two different values matching is ambiguous and returns [].
 */
export function matchRedacted(keys: KeyRecord[], redacted: string): string[] {
  const m = redacted.match(/^(.*?)(?:\*+|\.\.\.|…)(.*)$/);
  if (!m) return [];
  const head = m[1] ?? "";
  const tail = m[2] ?? "";
  if (tail.length < 4) return [];
  const hits = keys.filter((k) => k.value.startsWith(head) && k.value.endsWith(tail));
  const values = new Set(hits.map((k) => k.fingerprint));
  return values.size === 1 ? hits.map((k) => k.id) : [];
}

export function needsAdmin(ctx: UsageContext, what: string): UsageResult {
  return { status: "needs-admin", scope: "none", allocated: false, message: `${what} → keys admin set ${ctx.provider.id} --clipboard`, rows: [], windows: [], remoteKeys: [] };
}
