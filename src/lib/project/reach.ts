// Turning a database target into a URL you can use from here, and the two
// long-lived helpers built on it: an SSM port-forward to a Drydock box, and
// Prisma Studio against any target.
//
// Drydock prod: the box's 5432 rule allows a few home IPs. When ours is one,
// the EIP URL works as is ("direct"). Otherwise an SSM port-forward
// (AWS-StartPortForwardingSessionToRemoteHost → 172.17.0.1:5432 on the box,
// Postgres's docker bridge address) brings it to 127.0.0.1. Sal gave this
// tool a standing OK for that tunnel (2026-10-28); it only opens on a press.

import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { IS_WIN } from "../platform.ts";
import { openInChrome } from "../run.ts";
import type { DbTarget } from "./db.ts";
import { tcpOpen } from "./db.ts";
import { dbReach, type DbReach } from "./drydock.ts";
import { jobs, type Job } from "./jobs.ts";
import { prismaCli, type PrismaSchema } from "./prisma.ts";

/** The AWS profile Drydock's account lives in (the default profile is the work account). */
export const DRYDOCK_AWS_PROFILE = process.env.DRYDOCK_AWS_PROFILE || "dested";
const BOX_PG_HOST = "172.17.0.1";
const PLUGIN_WIN = "C:\\Program Files\\Amazon\\SessionManagerPlugin\\bin\\session-manager-plugin.exe";

/** null when the SSM tunnel can run, else what's missing and how to get it. */
export function tunnelUnavailable(): string | null {
  if (!Bun.which("aws")) return "the aws CLI isn't on PATH";
  if (Bun.which("session-manager-plugin") || (IS_WIN && existsSync(PLUGIN_WIN))) return null;
  return IS_WIN ? "needs AWS's session-manager-plugin — winget install Amazon.SessionManagerPlugin" : "needs AWS's session-manager-plugin";
}

/** A port nothing is bound to, from `start` up. */
export async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 200; p++) {
    const free = await new Promise<boolean>((done) => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen(p, "127.0.0.1", () => s.close(() => done(true)));
    });
    if (free) return p;
  }
  throw new Error(`no free port in ${start}–${start + 199}`);
}

function withHost(url: string, host: string, port: number): string {
  const u = new URL(url);
  u.hostname = host;
  u.port = String(port);
  return u.toString();
}

// ─── drydock reach, cached per app for the session ───────────────────────────

export type ReachMode = "direct" | "tunnel";

export interface Reached {
  url: string;
  mode: ReachMode;
}

const reaches = new Map<string, Promise<DbReach | null>>();

/** The portal's answer for this app, fetched once per session (it carries the password). */
export function reachOf(app: string, refresh = false): Promise<DbReach | null> {
  const hit = reaches.get(app);
  if (hit && !refresh) return hit;
  const p = dbReach(app);
  reaches.set(app, p);
  p.catch(() => reaches.delete(app));
  return p;
}

const tunnelKey = (app: string) => `tunnel:${app}`;

export function tunnelJob(app: string): Job | null {
  return jobs.live(tunnelKey(app));
}

/** Open (or reuse) the SSM port-forward for an app; resolves once 127.0.0.1:<port> accepts. */
export async function openTunnel(project: string, app: string, reach: DbReach): Promise<string> {
  const live = tunnelJob(app);
  const port = live?.spec.readyPort ?? (await freePort(15432));
  if (!live) {
    const why = tunnelUnavailable();
    if (why) throw new Error(why);
    if (!reach.instanceId) throw new Error("the portal didn't say which box this app is on");
    jobs.start({
      key: tunnelKey(app),
      project,
      kind: "tunnel",
      label: `tunnel → ${app}`,
      command: `aws ssm start-session --region ${reach.region} --target ${reach.instanceId} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=${BOX_PG_HOST},portNumber=5432,localPortNumber=${port}`,
      cwd: process.cwd(),
      env: { AWS_PROFILE: DRYDOCK_AWS_PROFILE },
      readyPort: port,
    });
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    const job = tunnelJob(app);
    if (!job) throw new Error("the tunnel exited — its output is in the console");
    if (job.phase === "ready") return withHost(reach.url, "127.0.0.1", port);
    if (Date.now() > deadline) throw new Error("the tunnel didn't come up in 30s");
    await Bun.sleep(300);
  }
}

/**
 * A URL that works from here, for any target. Drydock: direct when the box
 * answers on 5432, else the tunnel (only when `allowTunnel`; it's a press).
 */
export async function resolveUrl(project: string, target: DbTarget, allowTunnel: boolean): Promise<Reached> {
  if (target.url) return { url: target.url, mode: "direct" };
  if (!target.app) throw new Error("no url for this target");
  const reach = await reachOf(target.app);
  if (!reach) throw new Error(`${target.app} has no database on Drydock`);
  const live = tunnelJob(target.app);
  if (live?.phase === "ready" && live.spec.readyPort) return { url: withHost(reach.url, "127.0.0.1", live.spec.readyPort), mode: "tunnel" };
  if (await tcpOpen(reach.host, 5432)) return { url: reach.url, mode: "direct" };
  if (!allowTunnel) throw new Error(`5432 on ${reach.host} isn't open to this IP — open the tunnel`);
  return { url: await openTunnel(project, target.app, reach), mode: "tunnel" };
}

// ─── prisma studio ───────────────────────────────────────────────────────────

const studioKey = (schema: PrismaSchema, target: DbTarget) => `studio:${schema.pkgDir}:${target.id}`;

export function studioJob(schema: PrismaSchema, target: DbTarget): Job | null {
  return jobs.live(studioKey(schema, target));
}

/** Start (or reopen) Prisma Studio for this schema against this target, then open it in Chrome. */
export async function openStudio(project: string, schema: PrismaSchema, target: DbTarget, url: string): Promise<Job> {
  const live = studioJob(schema, target);
  if (live) {
    if (live.phase === "ready" && live.spec.readyPort) openInChrome(`http://localhost:${live.spec.readyPort}`);
    return live;
  }
  const port = await freePort(5555);
  return jobs.start({
    key: studioKey(schema, target),
    project,
    kind: "studio",
    label: `studio · ${target.label}`,
    command: `${prismaCli(schema.pm)} studio --port ${port} --browser none`,
    cwd: schema.pkgDir,
    env: { [schema.urlEnv]: url },
    readyPort: port,
    onReady: () => openInChrome(`http://localhost:${port}`),
  });
}
