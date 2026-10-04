// fal: the Platform API creates and deletes keys with an admin API key.
// POST   https://api.fal.ai/v1/keys  {alias} → key_id, key_secret, key ("id:secret", the FAL_KEY format)
// DELETE https://api.fal.ai/v1/keys/{key_id}
// Auth header is `Key <admin key>`, not Bearer.

import { z } from "zod";
import { call, json, remoteName, type AdminInput, type MintAdapter } from "./types.ts";

const API = "https://api.fal.ai/v1/keys";

const createdSchema = z.object({ key_id: z.string(), key_secret: z.string().min(1), key: z.string().optional() });

function auth(admin: AdminInput): Record<string, string> {
  return { Authorization: `Key ${admin.value}` };
}

export const fal: MintAdapter = {
  id: "fal",
  adminConsoleUrl: "https://fal.ai/dashboard/keys",
  adminKind: "API key with the ADMIN scope",
  async mint(admin, ctx) {
    const res = await call(API, json("POST", auth(admin), { alias: remoteName(ctx) }), createdSchema);
    return { value: res.key ?? `${res.key_id}:${res.key_secret}`, remoteId: res.key_id, note: `key ${res.key_id}` };
  },
  async revoke(admin, remoteId) {
    await call(`${API}/${remoteId}`, json("DELETE", auth(admin)), z.unknown());
  },
};
