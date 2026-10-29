// The whole project picture in one async call: what `destedtui --project
// --json` prints and what the panel's slow half loads. Nothing in here holds
// a secret: database targets carry `where` (host:port/db), never a URL.

import { discover, type Discovery } from "../discovery.ts";
import { ProcSampler, type ProcScan } from "../procs.ts";
import { inspectProject, type ProjectDetail } from "../projects.ts";
import { inside, type ProjectRef } from "./context.ts";
import { buildTargets, diffMigrations, probeDb, type DbProbe, type DbTarget } from "./db.ts";
import { appDetail, appsForFolder, cachedAppNames, type AppDetail, type DrydockApp } from "./drydock.ts";
import { recentCommits, staticPicture, type Commit, type StaticPicture } from "./inspect.ts";
import { jobs } from "./jobs.ts";
import type { PrismaSchema } from "./prisma.ts";
import { resolveUrl, type ReachMode } from "./reach.ts";
import { IS_WIN, winToLinux } from "../platform.ts";
import { projectServers, projectSessions, wslServers, type ProjectServer } from "./servers.ts";

export interface DrydockPicture {
  apps: DrydockApp[];
  details: Record<string, AppDetail>;
  /** portal unreachable etc.; apps then come from the keys cache by name only */
  error: string | null;
}

export async function loadDrydock(folder: string): Promise<DrydockPicture> {
  try {
    const apps = await appsForFolder(folder);
    const details: Record<string, AppDetail> = {};
    await Promise.all(apps.map(async (a) => (details[a.name] = await appDetail(a.name))));
    return { apps, details, error: null };
  } catch (err) {
    const names = cachedAppNames(folder);
    return {
      apps: names.map((name) => ({ name, domain: null, repo: "", database: true, prisma: false, predeploy: null, desired: 0, running: 0 })),
      details: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface TargetProbe {
  probe: DbProbe;
  mode: ReachMode | null;
}

/** Probe one target; Drydock targets only when they're reachable without opening a tunnel (or one is up). */
export async function probeTarget(project: string, t: DbTarget): Promise<TargetProbe> {
  try {
    const { url, mode } = await resolveUrl(project, t, false);
    return { probe: await probeDb(url), mode };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { probe: { ok: false, version: null, bytes: null, tables: null, applied: null, failed: 0, error: m, at: Date.now() }, mode: null };
  }
}

export interface Picture {
  ref: ProjectRef;
  discovery: Discovery;
  stat: StaticPicture;
  drydock: DrydockPicture;
  targets: DbTarget[];
  probes: Record<string, TargetProbe>;
  servers: ProjectServer[];
  sessions: ProcScan["groups"];
  git: ProjectDetail;
  commits: Commit[];
}

export async function gather(ref: ProjectRef, opts: { probe?: boolean } = {}): Promise<Picture> {
  const discovery = await discover(ref.dir);
  const stat = staticPicture(ref.dir, discovery);
  const [drydock, git, commits] = await Promise.all([loadDrydock(ref.name), inspectProject(ref.dir), recentCommits(ref.dir)]);
  const targets = buildTargets(discovery.databases, drydock.apps.filter((a) => a.database).map((a) => a.name));
  const probes: Record<string, TargetProbe> = {};
  if (opts.probe !== false) await Promise.all(targets.map(async (t) => (probes[t.id] = await probeTarget(ref.dir, t))));
  // Two scans: the sampler needs a previous one for cpu, and we only want ports anyway.
  const scan = new ProcSampler().scan();
  const panelPids = new Set(jobs.list(ref.dir).map((j) => j.pid));
  const wsl = IS_WIN && winToLinux(ref.dir) ? ((await wslServers()) ?? []) : [];
  return { ref, discovery, stat, drydock, targets, probes, servers: projectServers(scan, ref.dir, panelPids, wsl), sessions: projectSessions(scan, ref.dir), git, commits };
}

/** The `--json` shape, version 1. Add fields, never rename them (agents read this). */
/** The schema a target belongs to: the package holding its .env (deepest wins), else the first. */
export function schemaFor(schemas: PrismaSchema[], t: DbTarget): PrismaSchema | null {
  if (t.kind !== "drydock") {
    const owners = schemas.filter((s) => inside(t.source, s.pkgDir)).sort((a, b) => b.pkgDir.length - a.pkgDir.length);
    if (owners[0]) return owners[0];
  }
  return schemas[0] ?? null;
}

export function toJson(p: Picture): unknown {
  return {
    v: 1,
    project: { name: p.ref.name, dir: p.ref.dir },
    git: {
      branch: p.git.branch,
      upstream: p.git.upstream,
      ahead: p.git.ahead,
      behind: p.git.behind,
      dirty: p.git.dirty,
      error: p.git.error,
      commits: p.commits,
    },
    packages: p.discovery.packages.map((k) => ({ rel: k.rel, name: k.name, pm: k.pm, scripts: Object.keys(k.scripts) })),
    dev: p.stat.dev,
    servers: p.servers.map((s) => ({
      ports: s.ports,
      urls: s.ports.map((port) => `http://localhost:${port}`),
      command: s.command,
      sub: s.sub,
      owner: s.owner,
      side: s.side,
      pid: s.rootPid,
      startedAt: s.startedAt,
      memory: s.memory,
    })),
    sessions: p.sessions.map((g) => ({ name: g.session?.name ?? null, label: g.session?.label ?? null, now: g.session?.now ?? null, cwd: g.session?.cwd ?? null })),
    prisma: p.stat.schemas.map((s) => ({
      rel: s.rel,
      schema: s.schemaPath,
      provider: s.provider,
      models: s.models,
      enums: s.enums,
      migrations: s.migrations.length,
      config: s.config,
      version: s.version,
      urlEnv: s.urlEnv,
    })),
    databases: p.targets.map((t) => {
      const r = p.probes[t.id];
      const schema = schemaFor(p.stat.schemas, t);
      const diff = r?.probe.applied && schema && schema.migrations.length ? diffMigrations(schema.migrations, r.probe.applied) : null;
      return {
        id: t.id,
        kind: t.kind,
        label: t.label,
        source: t.source,
        where: t.where,
        app: t.app,
        reachable: r?.probe.ok ?? null,
        via: r?.mode ?? null,
        version: r?.probe.version ?? null,
        bytes: r?.probe.bytes ?? null,
        tables: r?.probe.tables ?? null,
        migrations: r?.probe.applied ? { applied: r.probe.applied.length, failed: r.probe.failed, pending: diff?.pending ?? [], unknown: diff?.unknown ?? [] } : null,
        error: r?.probe.error ?? null,
      };
    }),
    env: p.stat.envFiles.map((f) => ({ rel: f.rel, names: f.names })),
    drydock: {
      error: p.drydock.error,
      apps: p.drydock.apps.map((a) => {
        const d = p.drydock.details[a.name];
        const primary = d?.state?.deployments.find((x) => x.status === "PRIMARY") ?? null;
        return {
          name: a.name,
          domain: a.domain,
          url: a.domain ? `https://${a.domain}` : null,
          running: a.running,
          desired: a.desired,
          prisma: a.prisma,
          predeploy: a.predeploy,
          deploy: primary ? { taskDef: primary.taskDef, rollout: primary.rolloutState ?? null, at: primary.createdAt ?? null } : null,
          envNames: d?.envNames ?? [],
        };
      }),
    },
  };
}
