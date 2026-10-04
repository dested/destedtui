// OpenRouter: a Management API key creates and deletes inference keys.
// POST   /api/v1/keys  {name} → key, data.hash
// DELETE /api/v1/keys/{hash}

import { z } from "zod";
import { call, json, remoteName, type AdminInput, type MintAdapter } from "./types.ts";

const API = "https://openrouter.ai/api/v1/keys";

const createdSchema = z.object({ key: z.string().min(1), data: z.object({ hash: z.string() }) });

function auth(admin: AdminInput): Record<string, string> {
  return { Authorization: `Bearer ${admin.value}` };
}

export const openrouter: MintAdapter = {
  id: "openrouter",
  adminConsoleUrl: "https://openrouter.ai/settings/management-keys",
  adminKind: "Management API key",
  async mint(admin, ctx) {
    const res = await call(API, json("POST", auth(admin), { name: remoteName(ctx) }), createdSchema);
    return { value: res.key, remoteId: res.data.hash, note: `key ${res.data.hash.slice(0, 12)}…` };
  },
  async revoke(admin, remoteId) {
    await call(`${API}/${remoteId}`, json("DELETE", auth(admin)), z.unknown());
  },
};
