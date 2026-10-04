// fal: per-key dollars from the Platform API (admin-scope key).
// GET https://api.fal.ai/v1/models/usage?start&end&timeframe=day&expand=time_series&expand=auth_method_structured
// → time_series[{bucket, results[{cost, auth_method_structured{api_key_id}}]}]
// A fal key is "<key_id>:<secret>", so matching is exact on the id half.
// Built from docs (2026-10-04); not exercised — no fal admin key yet.

import { z } from "zod";
import { call, json } from "../adapters/types.ts";
import type { RemoteKey, UsageRow } from "./cache.ts";
import { utcDay, utcDayStart } from "./cache.ts";
import { keysOf, needsAdmin, type UsageFetcher } from "./types.ts";

const pageSchema = z.object({
  time_series: z
    .array(
      z.object({
        bucket: z.string(),
        results: z.array(z.object({ cost: z.number().default(0), auth_method_structured: z.object({ api_key_id: z.string().nullable().optional() }).nullable().optional() })),
      }),
    )
    .default([]),
  next_cursor: z.string().nullable().optional(),
  has_more: z.boolean().optional(),
});

export const falUsage: UsageFetcher = {
  id: "fal",
  async fetch(ctx) {
    if (!ctx.admin) return needsAdmin(ctx, "a fal API key with the ADMIN scope");
    const start = new Date(utcDayStart(ctx.now, ctx.days - 1)).toISOString();
    const rows: UsageRow[] = [];
    let cursor: string | null | undefined;
    for (let i = 0; i < 30; i++) {
      const q = `start=${start}&timeframe=day&expand=time_series&expand=auth_method_structured&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await call(`https://api.fal.ai/v1/models/usage?${q}`, json("GET", { Authorization: `Key ${ctx.admin.value}` }), pageSchema);
      for (const b of res.time_series)
        for (const r of b.results) if (r.cost) rows.push({ remoteKeyId: r.auth_method_structured?.api_key_id ?? null, day: utcDay(Date.parse(b.bucket)), usd: r.cost });
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    const vaultKeys = keysOf(ctx);
    const remoteKeys: RemoteKey[] = [...new Set(rows.flatMap((r) => (r.remoteKeyId ? [r.remoteKeyId] : [])))].map((id) => {
      const ids = vaultKeys.filter((k) => k.value.split(":")[0] === id).map((k) => k.id);
      return { remoteKeyId: id, vaultKeyIds: ids, matchedBy: ids.length ? "key-id" : undefined };
    });
    return { status: "ok", scope: "per-key", allocated: false, rows, windows: [], remoteKeys };
  },
};
