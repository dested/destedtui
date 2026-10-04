// OpenAI: a key is a project service account (the openai-image skill's approach).
// POST   /v1/organization/projects/{project}/service_accounts  → api_key.value
// DELETE /v1/organization/projects/{project}/service_accounts/{id}
// Which OpenAI project: admin meta `projectId`, else one named like the Sal
// project, else "Default project", else the first active one.

import { z } from "zod";
import { ProviderError } from "../errors.ts";
import { call, json, remoteName, splitRemote, type AdminInput, type MintAdapter } from "./types.ts";

const API = "https://api.openai.com/v1/organization";

const projectsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
});
const serviceAccountSchema = z.object({
  id: z.string(),
  api_key: z.object({ id: z.string(), value: z.string().min(1) }),
});

function auth(admin: AdminInput): Record<string, string> {
  return { Authorization: `Bearer ${admin.value}` };
}

async function pickProject(admin: AdminInput, project: string): Promise<{ id: string; name: string }> {
  const list = await call(`${API}/projects?limit=100`, json("GET", auth(admin)), projectsSchema);
  const active = list.data.filter((p) => p.status === "active");
  const pinned = admin.meta.projectId;
  const hit =
    (pinned ? active.find((p) => p.id === pinned) : undefined) ??
    active.find((p) => p.name.toLowerCase() === project.toLowerCase()) ??
    active.find((p) => p.name === "Default project") ??
    active[0];
  if (!hit) throw new ProviderError("openai: no active project in this organization");
  return hit;
}

async function deleteServiceAccount(admin: AdminInput, projectId: string, saId: string): Promise<void> {
  const url = `${API}/projects/${projectId}/service_accounts/${saId}`;
  try {
    await call(url, json("DELETE", auth(admin)), z.unknown());
  } catch {
    // A just-created account can 404 on an immediate delete (propagation lag) — wait, retry once.
    await Bun.sleep(3000);
    await call(url, json("DELETE", auth(admin)), z.unknown());
  }
}

export const openai: MintAdapter = {
  id: "openai",
  adminConsoleUrl: "https://platform.openai.com/settings/organization/admin-keys",
  adminKind: "Admin key (sk-admin-…)",
  adminEnvVar: "OPENAI_ADMIN_KEY",
  async mint(admin, ctx) {
    const project = await pickProject(admin, ctx.project);
    const sa = await call(
      `${API}/projects/${project.id}/service_accounts`,
      json("POST", auth(admin), { name: remoteName(ctx) }),
      serviceAccountSchema,
    );
    return {
      value: sa.api_key.value,
      remoteId: `${project.id}/${sa.id}`,
      note: `service account ${sa.id} in OpenAI project "${project.name}"`,
    };
  },
  async revoke(admin, remoteId) {
    const [projectId, saId] = splitRemote("openai", remoteId);
    await deleteServiceAccount(admin, projectId, saId);
  },
};
