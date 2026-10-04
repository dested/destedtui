// OpenRouter: each key reports its own spend — GET /api/v1/key with the key itself.
// usage_daily = today (UTC), usage_weekly = this UTC week (Mon–Sun), in USD.
// No admin key needed and no day series, so these land as windows, not daily rows.

import { z } from "zod";
import { call, json } from "../adapters/types.ts";
import type { RemoteKey, WindowRow } from "./cache.ts";
import { keysOf, type UsageFetcher } from "./types.ts";

const keySchema = z.object({
  data: z.object({ label: z.string().nullable().optional(), usage_daily: z.number().default(0), usage_weekly: z.number().default(0) }),
});

export const openrouterUsage: UsageFetcher = {
  id: "openrouter",
  async fetch(ctx) {
    const byValue = new Map<string, string[]>(); // fingerprint → vault key ids
    const valueOf = new Map<string, string>();
    for (const k of keysOf(ctx)) {
      if (k.revokedAt !== undefined) continue;
      byValue.set(k.fingerprint, [...(byValue.get(k.fingerprint) ?? []), k.id]);
      valueOf.set(k.fingerprint, k.value);
    }
    const windows: WindowRow[] = [];
    const remoteKeys: RemoteKey[] = [];
    const errors: string[] = [];
    for (const [fp, value] of valueOf) {
      try {
        const res = await call("https://openrouter.ai/api/v1/key", json("GET", { Authorization: `Bearer ${value}` }), keySchema);
        windows.push({ remoteKeyId: fp, today: res.data.usage_daily, week: res.data.usage_weekly });
        // An unnamed key's label is its own redacted value ("sk-or-v1-99f...") — never cache that.
        const label = res.data.label && !/^sk-/.test(res.data.label) ? res.data.label : undefined;
        remoteKeys.push({ remoteKeyId: fp, name: label, vaultKeyIds: byValue.get(fp) ?? [], matchedBy: "value" });
      } catch (err) {
        errors.push(`fp ${fp}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (valueOf.size === 0) return { status: "ok", scope: "per-key", allocated: false, message: "no OpenRouter keys in the vault", rows: [], windows, remoteKeys };
    return {
      status: errors.length && !windows.length ? "error" : "ok",
      scope: "per-key",
      allocated: false,
      message: errors.length ? errors.join("; ") : undefined,
      rows: [],
      windows,
      remoteKeys,
    };
  },
};
