// Anthropic: the Admin API lists, updates and archives API keys but has no
// create endpoint (checked 2026-10-03: /v1/organizations/api_keys exposes only
// list, retrieve, update). So no `mint` — keys are made in the console — but a
// revoke archives the key, and `locate` finds a pasted key's id from its
// partial_key_hint ("sk-ant-api03-R2D...igAA").

import { z } from "zod";
import { call, json, type AdminInput, type MintAdapter } from "./types.ts";

const API = "https://api.anthropic.com/v1/organizations/api_keys";

const keySchema = z.object({ id: z.string(), partial_key_hint: z.string().nullable(), status: z.string() });
const listSchema = z.object({ data: z.array(keySchema), has_more: z.boolean(), last_id: z.string().nullable() });

function headers(admin: AdminInput): Record<string, string> {
  return { "x-api-key": admin.value, "anthropic-version": "2023-06-01" };
}

/** True when a redacted hint ("sk-ant-api03-R2D...igAA") could be this value. Also used by usage matching. */
export function matchesHint(value: string, hint: string): boolean {
  const cut = hint.indexOf("...");
  if (cut < 0) return false;
  const head = hint.slice(0, cut);
  const tail = hint.slice(cut + 3);
  return head.length > 0 && tail.length > 0 && value.startsWith(head) && value.endsWith(tail);
}

export const anthropic: MintAdapter = {
  id: "anthropic",
  adminConsoleUrl: "https://platform.claude.com/settings/admin-keys",
  adminKind: "Admin key (sk-ant-admin…)",
  adminEnvVar: "ANTHROPIC_ADMIN_KEY",
  async revoke(admin, remoteId) {
    await call(`${API}/${remoteId}`, json("POST", headers(admin), { status: "archived" }), keySchema);
  },
  async locate(admin, value) {
    let after: string | null = null;
    const hits: string[] = [];
    for (let page = 0; page < 20; page++) {
      const q: string = after ? `?limit=1000&after_id=${after}` : "?limit=1000";
      const res = await call(`${API}${q}`, json("GET", headers(admin)), listSchema);
      for (const k of res.data) if (k.partial_key_hint && matchesHint(value, k.partial_key_hint)) hits.push(k.id);
      if (!res.has_more || !res.last_id) break;
      after = res.last_id;
    }
    return hits.length === 1 ? hits[0] : undefined;
  },
};
