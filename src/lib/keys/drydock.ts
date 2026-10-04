// Drydock client: the portal's plain tRPC at http://localhost:4400/trpc (no
// transformer, so queries are GET ?input=<json> and mutations POST <json>).
//
// keys is only a client of that API. Env values come back decrypted from
// projects.env.list; they never leave this module — callers get fingerprints.

import { z } from "zod";
import { ProviderError } from "./errors.ts";
import { fingerprint } from "./vault.ts";

export const DRYDOCK_URL = process.env.DRYDOCK_URL || "http://localhost:4400/trpc";
const TIMEOUT_MS = 20_000;

const trpcError = z.object({ error: z.object({ message: z.string() }).passthrough() });

async function trpc<S extends z.ZodType>(kind: "query" | "mutation", path: string, input: unknown, schema: S): Promise<z.infer<S>> {
  const url = kind === "query" ? `${DRYDOCK_URL}/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}` : `${DRYDOCK_URL}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: kind === "query" ? "GET" : "POST",
      headers: kind === "mutation" ? { "Content-Type": "application/json" } : undefined,
      body: kind === "mutation" ? JSON.stringify(input ?? null) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(`drydock portal unreachable at ${DRYDOCK_URL} (${err instanceof Error ? err.message : String(err)}) — bun run dev in G:\\code\\drydock`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProviderError(`drydock ${path} → HTTP ${res.status}, not JSON`);
  }
  if (!res.ok) {
    const e = trpcError.safeParse(body);
    throw new ProviderError(`drydock ${path} → HTTP ${res.status}: ${e.success ? e.data.error.message.slice(0, 300) : "error"}`);
  }
  const envelope = z.object({ result: z.object({ data: z.unknown() }) }).safeParse(body);
  const parsed = schema.safeParse(envelope.success ? envelope.data.result.data : undefined);
  if (!parsed.success) throw new ProviderError(`drydock ${path} returned an unexpected shape (${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join("; ")})`);
  return parsed.data;
}

// ─── apps ────────────────────────────────────────────────────────────────────

const appSchema = z.object({
  name: z.string(),
  repo: z.string().default(""),
  config: z.object({ rootDir: z.string().default(""), domains: z.array(z.string()).default([]) }).passthrough(),
  state: z.object({ desired: z.number(), running: z.number() }).passthrough().nullable().default(null),
});

export interface DrydockApp {
  name: string;
  /** owner/repo, "" when the project has none. */
  repo: string;
  rootDir: string;
  domain: string | null;
  desired: number;
  running: number;
}

export async function listApps(): Promise<DrydockApp[]> {
  const apps = await trpc("query", "projects.list", undefined, z.array(appSchema));
  return apps.map((a) => ({
    name: a.name,
    repo: a.repo,
    rootDir: a.config.rootDir,
    domain: a.config.domains[0] ?? null,
    desired: a.state?.desired ?? 0,
    running: a.state?.running ?? 0,
  }));
}

// ─── env ─────────────────────────────────────────────────────────────────────

/** One env var on a deployed app: its fingerprint, or null when the portal gave the name without a value. */
export type EnvPrint = Record<string, string | null>;

/** The app's SSM env, as var → fingerprint. The values themselves stay here. */
export async function envPrints(app: string): Promise<EnvPrint> {
  const env = await trpc("query", "projects.env.list", { name: app }, z.record(z.string(), z.string().nullable()));
  const out: EnvPrint = {};
  for (const [k, v] of Object.entries(env)) out[k] = v ? fingerprint(v) : null;
  return out;
}

export async function setEnv(app: string, key: string, value: string): Promise<void> {
  await trpc("mutation", "projects.env.set", { name: app, key, value }, z.unknown());
}

/** Portal "Apply + redeploy": re-registers the task def (so new SSM keys reach it) and forces a deployment. */
export async function applyAndRedeploy(app: string): Promise<void> {
  await trpc("mutation", "projects.env.applyChanges", { name: app }, z.unknown());
}

// ─── deploy state ────────────────────────────────────────────────────────────

const stateSchema = z.object({
  exists: z.boolean(),
  desired: z.number(),
  running: z.number(),
  taskDefArn: z.string().optional(),
  deployments: z.array(
    z.object({
      status: z.string(),
      taskDef: z.string(),
      desired: z.number(),
      running: z.number(),
      failed: z.number(),
      rolloutState: z.string().optional(),
      createdAt: z.string().optional(),
    }),
  ),
  events: z.array(z.object({ message: z.string(), createdAt: z.string().optional() })),
});
export type ServiceState = z.infer<typeof stateSchema>;

export async function serviceState(app: string): Promise<ServiceState> {
  return trpc("query", "projects.state", { name: app }, stateSchema);
}

export interface DeployOutcome {
  ok: boolean;
  /** Task-def revision that ended up PRIMARY, e.g. drydock-dink:41. */
  taskDef: string;
  note: string;
  seconds: number;
}

/**
 * Follow the deployment an apply just started: the newest PRIMARY deployment
 * created at/after `since` must reach rolloutState COMPLETED with its tasks
 * running. FAILED (circuit breaker) or a rollback to an older revision is a failure.
 */
export async function waitForDeploy(
  app: string,
  since: number,
  opts: { timeoutMs?: number; pollMs?: number; onTick?: (line: string) => void } = {},
): Promise<DeployOutcome> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const poll = opts.pollMs ?? 5000;
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  for (;;) {
    const s = await serviceState(app);
    const fresh = s.deployments.filter((d) => d.createdAt && Date.parse(d.createdAt) >= since - 5000);
    const primary = s.deployments.find((d) => d.status === "PRIMARY");
    const ours = fresh.find((d) => d.status === "PRIMARY") ?? fresh[0];
    if (ours?.rolloutState === "FAILED" || (ours && ours.failed > 0 && ours.status !== "PRIMARY")) {
      const why = s.events.find((e) => /fail|unable|stopped/i.test(e.message))?.message ?? "deployment failed";
      return { ok: false, taskDef: ours.taskDef, note: why.slice(0, 200), seconds: secs() };
    }
    if (ours && ours.status === "PRIMARY" && ours.rolloutState === "COMPLETED" && ours.running >= Math.max(1, ours.desired)) {
      return { ok: true, taskDef: ours.taskDef, note: `${ours.taskDef} running`, seconds: secs() };
    }
    if (!ours && primary && fresh.length === 0 && Date.now() - started > 60_000) {
      return { ok: false, taskDef: primary.taskDef, note: "no new deployment appeared within a minute of the apply", seconds: secs() };
    }
    opts.onTick?.(ours ? `${ours.taskDef} ${ours.rolloutState ?? ours.status} · ${ours.running}/${ours.desired} running` : "waiting for the deployment to appear");
    if (Date.now() - started > timeout) return { ok: false, taskDef: ours?.taskDef ?? "", note: `still not stable after ${Math.round(timeout / 60_000)} min`, seconds: secs() };
    await Bun.sleep(poll);
  }
}
