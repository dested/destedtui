// Anthropic: tokens per API key from the usage report, dollars from the cost report.
// GET /v1/organizations/usage_report/messages?group_by[]=api_key_id&group_by[]=model  (1d)
// GET /v1/organizations/cost_report?group_by[]=description                          (1d, cents)
// The cost report can't group by key, so each key's dollars are ALLOCATED: every
// (day, model, token type) cost is split by that key's share of those tokens.
// Non-token costs (web search, code execution, sessions) stay on the account row.
// Keys are matched to the vault by partial_key_hint.

import { z } from "zod";
import { call, json } from "../adapters/types.ts";
import type { RemoteKey, UsageRow } from "./cache.ts";
import { utcDay, utcDayStart } from "./cache.ts";
import { keysOf, matchRedacted, needsAdmin, type UsageFetcher } from "./types.ts";

const API = "https://api.anthropic.com/v1/organizations";

const TOKEN_TYPES = [
  "uncached_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "cache_creation.ephemeral_5m_input_tokens",
  "cache_creation.ephemeral_1h_input_tokens",
] as const;
type TokenType = (typeof TOKEN_TYPES)[number];

const usageSchema = z.object({
  data: z.array(
    z.object({
      starting_at: z.string(),
      results: z.array(
        z.object({
          api_key_id: z.string().nullable(),
          model: z.string().nullable(),
          uncached_input_tokens: z.number().default(0),
          cache_read_input_tokens: z.number().default(0),
          output_tokens: z.number().default(0),
          cache_creation: z.object({ ephemeral_5m_input_tokens: z.number().default(0), ephemeral_1h_input_tokens: z.number().default(0) }).optional(),
        }),
      ),
    }),
  ),
  has_more: z.boolean(),
  next_page: z.string().nullable(),
});
const costSchema = z.object({
  data: z.array(
    z.object({
      starting_at: z.string(),
      results: z.array(z.object({ amount: z.string(), model: z.string().nullable().optional(), token_type: z.string().nullable().optional(), cost_type: z.string().nullable().optional() })),
    }),
  ),
  has_more: z.boolean(),
  next_page: z.string().nullable(),
});
const keysSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().nullable().optional(), partial_key_hint: z.string().nullable() })),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});

function tokensOf(r: z.infer<typeof usageSchema>["data"][number]["results"][number], t: TokenType): number {
  if (t === "cache_creation.ephemeral_5m_input_tokens") return r.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  if (t === "cache_creation.ephemeral_1h_input_tokens") return r.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return r[t];
}

function isTokenType(t: string): t is TokenType {
  return (TOKEN_TYPES as readonly string[]).includes(t);
}

async function pages<S extends z.ZodType<{ has_more: boolean; next_page: string | null }>>(
  url: (page: string | null) => string,
  headers: Record<string, string>,
  schema: S,
): Promise<z.infer<S>[]> {
  const out: z.infer<S>[] = [];
  let page: string | null = null;
  for (let i = 0; i < 30; i++) {
    const res: z.infer<S> = await call(url(page), json("GET", headers), schema);
    out.push(res);
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }
  return out;
}

export const anthropicUsage: UsageFetcher = {
  id: "anthropic",
  async fetch(ctx) {
    if (!ctx.admin) return needsAdmin(ctx, "an Anthropic Admin key (sk-ant-admin…)");
    const headers = { "x-api-key": ctx.admin.value, "anthropic-version": "2023-06-01" };
    const since = new Date(utcDayStart(ctx.now, ctx.days - 1)).toISOString();
    const limit = Math.min(31, ctx.days + 1);
    const pg = (p: string | null) => (p ? `&page=${encodeURIComponent(p)}` : "");

    const usage = await pages(
      (p) => `${API}/usage_report/messages?starting_at=${since}&bucket_width=1d&limit=${limit}&group_by[]=api_key_id&group_by[]=model${pg(p)}`,
      headers,
      usageSchema,
    );
    const cost = await pages((p) => `${API}/cost_report?starting_at=${since}&limit=${limit}&group_by[]=description${pg(p)}`, headers, costSchema);

    // tokens[day][model][type] → per key and total
    const perKey = new Map<string, Map<string | null, number>>(); // `${day}|${model}|${type}` → key → tokens
    const totals = new Map<string, number>();
    for (const res of usage)
      for (const b of res.data) {
        const day = utcDay(Date.parse(b.starting_at));
        for (const r of b.results)
          for (const t of TOKEN_TYPES) {
            const n = tokensOf(r, t);
            if (!n) continue;
            // Exact (day, model, type) slot, plus a model-less one in case the cost
            // report names a model differently from the usage report.
            for (const slot of [`${day}|${r.model ?? ""}|${t}`, `${day}|*|${t}`]) {
              const m = perKey.get(slot) ?? new Map<string | null, number>();
              m.set(r.api_key_id, (m.get(r.api_key_id) ?? 0) + n);
              perKey.set(slot, m);
              totals.set(slot, (totals.get(slot) ?? 0) + n);
            }
          }
      }

    const usd = new Map<string, number>(); // `${day}|${key}` → dollars
    const add = (day: string, key: string | null, v: number) => usd.set(`${day}|${key ?? ""}`, (usd.get(`${day}|${key ?? ""}`) ?? 0) + v);
    for (const res of cost)
      for (const b of res.data) {
        const day = utcDay(Date.parse(b.starting_at));
        for (const r of b.results) {
          const dollars = Number.parseFloat(r.amount) / 100;
          if (!Number.isFinite(dollars) || dollars === 0) continue;
          const exact = `${day}|${r.model ?? ""}|${r.token_type ?? ""}`;
          const slot = perKey.has(exact) ? exact : `${day}|*|${r.token_type ?? ""}`;
          const shares = r.token_type && isTokenType(r.token_type) ? perKey.get(slot) : undefined;
          const total = totals.get(slot) ?? 0;
          if (!shares || total === 0) {
            add(day, null, dollars);
            continue;
          }
          for (const [key, n] of shares) add(day, key, (dollars * n) / total);
        }
      }
    const rows: UsageRow[] = [...usd].map(([k, v]) => {
      const [day = "", key = ""] = k.split("|");
      return { remoteKeyId: key || null, day, usd: v };
    });

    const vaultKeys = keysOf(ctx);
    const remote = new Map<string, RemoteKey>();
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const res: z.infer<typeof keysSchema> = await call(`${API}/api_keys?limit=1000${after ? `&after_id=${after}` : ""}`, json("GET", headers), keysSchema);
      for (const k of res.data) {
        const ids = k.partial_key_hint ? matchRedacted(vaultKeys, k.partial_key_hint) : [];
        remote.set(k.id, { remoteKeyId: k.id, name: k.name ?? undefined, vaultKeyIds: ids, matchedBy: ids.length ? "key-hint" : undefined });
      }
      if (!res.has_more || !res.last_id) break;
      after = res.last_id;
    }
    for (const r of rows) if (r.remoteKeyId && !remote.has(r.remoteKeyId)) remote.set(r.remoteKeyId, { remoteKeyId: r.remoteKeyId, vaultKeyIds: [] });

    return { status: "ok", scope: "per-key", allocated: true, rows, windows: [], remoteKeys: [...remote.values()] };
  },
};
