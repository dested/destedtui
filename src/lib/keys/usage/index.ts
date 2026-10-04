// Fetch every provider's usage in parallel and cache it. A provider that fails,
// lacks an admin key or has no usage API gets a status row; it never sinks the rest.

import { adminFor } from "../ops.ts";
import { readVault } from "../vault.ts";
import { anthropicUsage } from "./anthropic.ts";
import { isStale, readUsageCache, writeUsageCache, type ProviderUsage, type UsageCache } from "./cache.ts";
import { elevenlabsUsage } from "./elevenlabs.ts";
import { falUsage } from "./fal.ts";
import { openaiUsage } from "./openai.ts";
import { openrouterUsage } from "./openrouter.ts";
import type { UsageFetcher } from "./types.ts";
import { xaiUsage } from "./xai.ts";

export const FETCHERS: ReadonlyMap<string, UsageFetcher> = new Map(
  [openaiUsage, anthropicUsage, elevenlabsUsage, openrouterUsage, falUsage, xaiUsage].map((f) => [f.id, f]),
);

export const DEFAULT_DAYS = 7;

export async function fetchUsage(days = DEFAULT_DAYS, now = Date.now()): Promise<UsageCache> {
  const vault = readVault();
  const fetchedAt = new Date(now).toISOString();
  const providers = await Promise.all(
    vault.providers.map(async (provider): Promise<ProviderUsage> => {
      const fetcher = FETCHERS.get(provider.id);
      if (!fetcher) {
        return { providerId: provider.id, status: "no-api", scope: "none", allocated: false, message: provider.consoleUrl, fetchedAt, rows: [], windows: [], remoteKeys: [] };
      }
      try {
        const res = await fetcher.fetch({ vault, provider, admin: adminFor(vault, provider)?.admin ?? null, days, now });
        return { providerId: provider.id, fetchedAt, ...res };
      } catch (err) {
        return { providerId: provider.id, status: "error", scope: "none", allocated: false, message: err instanceof Error ? err.message : String(err), fetchedAt, rows: [], windows: [], remoteKeys: [] };
      }
    }),
  );
  const cache: UsageCache = { version: 1, fetchedAt, days, providers };
  writeUsageCache(cache);
  return cache;
}

/** The cached usage when it's fresh enough, else a refetch. */
export async function getUsage(opts: { days?: number; refresh?: boolean } = {}): Promise<UsageCache> {
  const days = opts.days ?? DEFAULT_DAYS;
  const cached = readUsageCache();
  if (!opts.refresh && cached && !isStale(cached, days)) return cached;
  return fetchUsage(Math.max(days, DEFAULT_DAYS));
}
