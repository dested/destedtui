// xAI: the Management API (management-api.x.ai) creates team API keys.
// POST   /auth/teams/{teamId}/api-keys  {name, acls} → apiKey, apiKeyId
// DELETE /auth/api-keys/{apiKeyId}
// teamId: admin meta `teamId`, else read off the management key itself via
// GET /auth/management-keys/validation.

import { z } from "zod";
import { ProviderError } from "../errors.ts";
import { call, json, remoteName, type AdminInput, type MintAdapter } from "./types.ts";

const API = "https://management-api.x.ai";

const validationSchema = z.object({ teamId: z.string().optional(), scopeId: z.string().optional(), scope: z.string().optional() });
const createdSchema = z.object({ apiKey: z.string().min(1), apiKeyId: z.string() });

function auth(admin: AdminInput): Record<string, string> {
  return { Authorization: `Bearer ${admin.value}` };
}

async function teamId(admin: AdminInput): Promise<string> {
  if (admin.meta.teamId) return admin.meta.teamId;
  const v = await call(`${API}/auth/management-keys/validation`, json("GET", auth(admin)), validationSchema);
  const id = v.scope === "SCOPE_TEAM" && v.scopeId ? v.scopeId : v.teamId;
  if (!id) throw new ProviderError("xai: the management key isn't scoped to a team — set it with --meta teamId=<id>");
  return id;
}

export const xai: MintAdapter = {
  id: "xai",
  adminConsoleUrl: "https://console.x.ai/team/default/management-keys",
  adminKind: "Management key (Management Keys read + write)",
  async mint(admin, ctx) {
    const team = await teamId(admin);
    const key = await call(
      `${API}/auth/teams/${team}/api-keys`,
      json("POST", auth(admin), { name: remoteName(ctx), acls: ["api-key:endpoint:*", "api-key:model:*"] }),
      createdSchema,
    );
    return { value: key.apiKey, remoteId: key.apiKeyId, note: `api key ${key.apiKeyId} in team ${team}` };
  },
  async revoke(admin, remoteId) {
    await call(`${API}/auth/api-keys/${remoteId}`, json("DELETE", auth(admin)), z.unknown());
  },
};
