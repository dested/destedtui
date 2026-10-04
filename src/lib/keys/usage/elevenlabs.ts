// ElevenLabs: credits AND dollars per API key per day from workspace analytics.
// POST /v1/workspace/analytics/query/usage-by-product-over-time
//      {start_time, end_time (ms), interval_seconds: 86400, group_by: ["hashed_xi_api_key"]}
// → tabular rows: hashed_xi_api_key, timestamp, total_usage (credits), total_cost (usd), api_key_name.
// The hash isn't a plain sha of the key (checked: sha1/sha256/sha512/md5/sha3 all miss), so
// keys are matched to the vault by NAME: a minted key's `keys-<project>-<label>` name, or
// a name equal to the project. Anything else shows under its own name, unmatched.
// The older /v1/usage/character-stats breakdown by api_keys came back empty (2026-10-03).

import { z } from "zod";
import { call, json, remoteName } from "../adapters/types.ts";
import type { RemoteKey, UsageRow } from "./cache.ts";
import { utcDay, utcDayStart } from "./cache.ts";
import { keysOf, type UsageFetcher } from "./types.ts";

const API = "https://api.elevenlabs.io/v1/workspace/analytics/query/usage-by-product-over-time";

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const tableSchema = z.object({ columns: z.array(z.string()), rows: z.array(z.array(cell)) });

function num(v: z.infer<typeof cell> | undefined): number {
  return typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) || 0 : 0;
}

export const elevenlabsUsage: UsageFetcher = {
  id: "elevenlabs",
  async fetch(ctx) {
    const vaultKeys = keysOf(ctx);
    // Any key of the workspace can read its analytics; prefer the admin credential.
    const caller = ctx.admin?.value ?? vaultKeys.find((k) => k.revokedAt === undefined)?.value;
    if (!caller) return { status: "needs-admin", scope: "none", allocated: false, message: "no ElevenLabs key in the vault to query with", rows: [], windows: [], remoteKeys: [] };

    const body = { start_time: utcDayStart(ctx.now, ctx.days - 1), end_time: ctx.now, interval_seconds: 86400, group_by: ["hashed_xi_api_key"] };
    const t = await call(API, json("POST", { "xi-api-key": caller }, body), tableSchema);
    const col = (name: string) => t.columns.indexOf(name);
    const [iHash, iTime, iCost, iUsage, iName] = [col("hashed_xi_api_key"), col("timestamp"), col("total_cost"), col("total_usage"), col("api_key_name")];

    const rows: UsageRow[] = [];
    const names = new Map<string, string>();
    for (const r of t.rows) {
      const hash = r[iHash];
      const key = typeof hash === "string" && hash ? hash : null;
      const time = r[iTime];
      const usd = num(r[iCost]);
      const units = num(r[iUsage]);
      if (typeof time !== "string" || (usd === 0 && units === 0)) continue;
      rows.push({ remoteKeyId: key, day: utcDay(Date.parse(time)), usd, units });
      const name = r[iName];
      if (key && typeof name === "string" && name) names.set(key, name);
    }

    const remoteKeys: RemoteKey[] = [];
    for (const key of new Set(rows.flatMap((r) => (r.remoteKeyId ? [r.remoteKeyId] : [])))) {
      const name = names.get(key);
      const lower = name?.toLowerCase();
      const hits = lower
        ? vaultKeys.filter((k) => remoteName({ project: k.project, label: k.label === "imported" ? "" : k.label }).toLowerCase() === lower || k.project.toLowerCase() === lower)
        : [];
      const ids = new Set(hits.map((k) => k.fingerprint)).size === 1 ? hits.map((k) => k.id) : [];
      remoteKeys.push({ remoteKeyId: key, name, vaultKeyIds: ids, matchedBy: ids.length ? "name" : undefined });
    }
    return { status: "ok", scope: "per-key", allocated: false, unit: "credits", rows, windows: [], remoteKeys };
  },
};
