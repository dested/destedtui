// xAI: account-level dollars per day from the Management API billing analytics.
// POST https://management-api.x.ai/v1/billing/teams/{team}/usage
//      {analyticsRequest: {timeRange, timeUnit: TIME_UNIT_DAY, values: [{name: "usd", aggregation: SUM}], groupBy: []}}
// The documented groupBy example is "description" (model); a per-key field isn't
// documented, so this reports the account only. Built from docs; not exercised.

import { z } from "zod";
import { call, json } from "../adapters/types.ts";
import { ProviderError } from "../errors.ts";
import type { UsageRow } from "./cache.ts";
import { utcDay, utcDayStart } from "./cache.ts";
import { needsAdmin, type UsageFetcher } from "./types.ts";

const API = "https://management-api.x.ai";
const validationSchema = z.object({ teamId: z.string().optional(), scopeId: z.string().optional(), scope: z.string().optional() });
const seriesSchema = z.object({
  timeSeries: z.array(z.object({ dataPoints: z.array(z.object({ timestamp: z.string(), values: z.array(z.number()) })) })).default([]),
});

function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export const xaiUsage: UsageFetcher = {
  id: "xai",
  async fetch(ctx) {
    if (!ctx.admin) return needsAdmin(ctx, "an xAI management key");
    const auth = { Authorization: `Bearer ${ctx.admin.value}` };
    let team = ctx.admin.meta.teamId;
    if (!team) {
      const v = await call(`${API}/auth/management-keys/validation`, json("GET", auth), validationSchema);
      team = v.scope === "SCOPE_TEAM" && v.scopeId ? v.scopeId : v.teamId;
    }
    if (!team) throw new ProviderError("xai: management key isn't scoped to a team");
    const body = {
      analyticsRequest: {
        timeRange: { startTime: stamp(utcDayStart(ctx.now, ctx.days - 1)), endTime: stamp(ctx.now), timezone: "Etc/GMT" },
        timeUnit: "TIME_UNIT_DAY",
        values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
        groupBy: [],
        filters: [],
      },
    };
    const res = await call(`${API}/v1/billing/teams/${team}/usage`, json("POST", auth, body), seriesSchema);
    const rows: UsageRow[] = [];
    for (const s of res.timeSeries)
      for (const p of s.dataPoints) {
        const usd = p.values[0] ?? 0;
        if (usd) rows.push({ remoteKeyId: null, day: utcDay(Date.parse(p.timestamp)), usd });
      }
    return { status: "ok", scope: "account", allocated: false, rows, windows: [], remoteKeys: [] };
  },
};
