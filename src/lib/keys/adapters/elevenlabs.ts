// ElevenLabs: keys belong to a workspace service account.
// POST   /v1/service-accounts/{sa}/api-keys  {name, permissions: "all"} → xi-api-key, key_id
// DELETE /v1/service-accounts/{sa}/api-keys/{key_id}
// Service accounts are multi-seat-only and admin-only (docs, 2026-10-03). The
// admin credential is an API key with service-account write access; the service
// account is admin meta `serviceAccountId`, else the first one, else a new
// "keys-vault" account.

import { z } from "zod";
import { call, json, remoteName, splitRemote, type AdminInput, type MintAdapter } from "./types.ts";

const API = "https://api.elevenlabs.io/v1/service-accounts";

const listSchema = z.object({
  "service-accounts": z.array(z.object({ service_account_user_id: z.string(), name: z.string() })),
});
const createdAccountSchema = z.object({ "service-account-user-id": z.string() });
const createdKeySchema = z.object({ "xi-api-key": z.string().min(1), key_id: z.string() });

function headers(admin: AdminInput): Record<string, string> {
  return { "xi-api-key": admin.value };
}

async function serviceAccount(admin: AdminInput): Promise<string> {
  if (admin.meta.serviceAccountId) return admin.meta.serviceAccountId;
  const list = await call(API, json("GET", headers(admin)), listSchema);
  const first = list["service-accounts"][0];
  if (first) return first.service_account_user_id;
  const made = await call(API, json("POST", headers(admin), { name: "keys-vault" }), createdAccountSchema);
  return made["service-account-user-id"];
}

export const elevenlabs: MintAdapter = {
  id: "elevenlabs",
  adminConsoleUrl: "https://elevenlabs.io/app/settings/api-keys",
  adminKind: "API key with service-account write (workspace admin, multi-seat plan)",
  async mint(admin, ctx) {
    const sa = await serviceAccount(admin);
    const key = await call(
      `${API}/${sa}/api-keys`,
      json("POST", headers(admin), { name: remoteName(ctx), permissions: "all" }),
      createdKeySchema,
    );
    return { value: key["xi-api-key"], remoteId: `${sa}/${key.key_id}`, note: `key ${key.key_id} on service account ${sa}` };
  },
  async revoke(admin, remoteId) {
    const [sa, keyId] = splitRemote("elevenlabs", remoteId);
    await call(`${API}/${sa}/api-keys/${keyId}`, json("DELETE", headers(admin)), z.unknown());
  },
};
