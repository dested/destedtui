// OpenAI: dollars per API key per day from the Admin API.
// GET /v1/organization/costs?group_by[]=api_key_id  (1d buckets; amount.value in USD)
// GET /v1/organization/projects/{id}/api_keys       (redacted_value, name, last_used_at)
// Keys are matched to the vault by redacted value (prefix + last 4).

import { z } from "zod";
import { call, json } from "../adapters/types.ts";
import type { RemoteKey, UsageRow } from "./cache.ts";
import { utcDay, utcDayStart } from "./cache.ts";
import { keysOf, matchRedacted, needsAdmin, type UsageFetcher } from "./types.ts";

const API = "https://api.openai.com/v1/organization";

const costsSchema = z.object({
  data: z.array(
    z.object({
      start_time: z.number(),
      results: z.array(z.object({ api_key_id: z.string().nullable().optional(), amount: z.object({ value: z.number() }).nullable().optional() })),
    }),
  ),
  has_more: z.boolean().optional(),
  next_page: z.string().nullable().optional(),
});
const projectsSchema = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) });
const apiKeysSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().nullable().optional(), redacted_value: z.string(), last_used_at: z.number().nullable().optional() })),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
});

export const openaiUsage: UsageFetcher = {
  id: "openai",
  async fetch(ctx) {
    if (!ctx.admin) return needsAdmin(ctx, "an OpenAI Admin key (or $env:OPENAI_ADMIN_KEY)");
    const auth = { Authorization: `Bearer ${ctx.admin.value}` };
    const start = Math.floor(utcDayStart(ctx.now, ctx.days - 1) / 1000);

    const rows: UsageRow[] = [];
    let page: string | null | undefined;
    for (let i = 0; i < 20; i++) {
      const q = `start_time=${start}&bucket_width=1d&limit=${Math.min(180, ctx.days + 1)}&group_by[]=api_key_id${page ? `&page=${encodeURIComponent(page)}` : ""}`;
      const res = await call(`${API}/costs?${q}`, json("GET", auth), costsSchema);
      for (const b of res.data)
        for (const r of b.results) if (r.amount && r.amount.value !== 0) rows.push({ remoteKeyId: r.api_key_id ?? null, day: utcDay(b.start_time * 1000), usd: r.amount.value });
      if (!res.has_more || !res.next_page) break;
      page = res.next_page;
    }

    // Name and match every key OpenAI still knows about; deleted keys stay unnamed.
    const remote = new Map<string, RemoteKey>();
    const vaultKeys = keysOf(ctx);
    const projects = await call(`${API}/projects?limit=100`, json("GET", auth), projectsSchema);
    for (const p of projects.data) {
      let after: string | null | undefined;
      for (let i = 0; i < 20; i++) {
        const q = `limit=100&owner_project_access=any${after ? `&after=${after}` : ""}`;
        const res = await call(`${API}/projects/${p.id}/api_keys?${q}`, json("GET", auth), apiKeysSchema);
        for (const k of res.data) {
          const ids = matchRedacted(vaultKeys, k.redacted_value);
          remote.set(k.id, {
            remoteKeyId: k.id,
            name: k.name ?? undefined,
            vaultKeyIds: ids,
            matchedBy: ids.length ? "redacted-value" : undefined,
            lastUsedAt: k.last_used_at ? new Date(k.last_used_at * 1000).toISOString() : undefined,
          });
        }
        if (!res.has_more || !res.last_id) break;
        after = res.last_id;
      }
    }
    for (const r of rows) if (r.remoteKeyId && !remote.has(r.remoteKeyId)) remote.set(r.remoteKeyId, { remoteKeyId: r.remoteKeyId, vaultKeyIds: [] });

    return { status: "ok", scope: "per-key", allocated: false, rows, windows: [], remoteKeys: [...remote.values()] };
  },
};
