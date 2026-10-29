import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ActionBar, btn, seg, type BarItem } from "../components/ActionBar.tsx";
import { Footer } from "../components/Footer.tsx";
import { fit, pad } from "../lib/text.ts";
import type { Route } from "../routes.ts";
import { discover, redactUrl, type Discovery } from "../lib/discovery.ts";
import { IS_WIN, winToLinux } from "../lib/platform.ts";
import { ProcSampler, type Group, type ProcScan } from "../lib/procs.ts";
import { probe, type Probe } from "../lib/ports.ts";
import { openInChrome } from "../lib/run.ts";
import { term } from "../lib/term.ts";
import { fmtBytes } from "../lib/pgtools.ts";
import { inspectProject, type ProjectDetail } from "../lib/projects.ts";
import { projectAt, type ProjectRef } from "../lib/project/context.ts";
import { buildTargets, diffMigrations, type DbTarget } from "../lib/project/db.ts";
import { cachedAppNames } from "../lib/project/drydock.ts";
import { recentCommits, staticPicture, type Commit, type DevCommand, type StaticPicture } from "../lib/project/inspect.ts";
import { jobs, type Job } from "../lib/project/jobs.ts";
import { loadDrydock, probeTarget, schemaFor, type DrydockPicture, type TargetProbe } from "../lib/project/picture.ts";
import { PRISMA_ACTIONS, prismaCli, type PrismaAction, type PrismaSchema } from "../lib/project/prisma.ts";
import { openStudio, openTunnel, reachOf, resolveUrl, studioJob, tunnelJob, tunnelUnavailable } from "../lib/project/reach.ts";
import { killServer as killProjectServer, projectServers, projectSessions, wslServers, WSL_MS, type ProjectServer, type WslServer } from "../lib/project/servers.ts";
import { projectUsage, type UsageMsg } from "../lib/project/usage.ts";

const ACCENT = T.teal;
const SCAN_MS = 2000;
const ARM_MS = 3500;
const FLASH_MS = 5000;
const TWO_COL = 150;

interface Props {
  cwd: string;
  go: (route: Route) => void;
  back: () => void;
}

/** The per-project panel: servers, databases, prisma, jobs; git, claude, drydock, env beside it. */
export function Project({ cwd, go, back }: Props) {
  const ref = useMemo(() => projectAt(cwd), [cwd]);
  if (!ref) return <NotAProject cwd={cwd} back={back} />;
  return <Panel project={ref} go={go} back={back} />;
}

function NotAProject({ cwd, back }: { cwd: string; back: () => void }) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "return") back();
  });
  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box title=" project " style={{ border: true, borderStyle: "rounded", borderColor: T.border, titleColor: ACCENT, margin: 1, marginTop: 0, padding: 1, flexGrow: 1, backgroundColor: T.panel }}>
        <text fg={T.dim}>{`${cwd} is a projects root — cd into a project (proj), then open this again`}</text>
      </box>
      <Footer hints={[["esc", "back"]]} />
    </box>
  );
}

type Probing = TargetProbe | "probing";

interface Armed {
  id: string;
  until: number;
  text: string;
  fire: () => void;
}

interface Flash {
  text: string;
  color: string;
  until: number;
}

type RowId = `srv:${string}` | `db:${string}`;

function Panel({ project, go, back }: { project: ProjectRef; go: (r: Route) => void; back: () => void }) {
  const { width, height } = useTerminalDimensions();
  const [disc, setDisc] = useState<Discovery | null>(null);
  const [stat, setStat] = useState<StaticPicture | null>(null);
  const [targets, setTargets] = useState<DbTarget[]>([]);
  const [probes, setProbes] = useState<Record<string, Probing>>({});
  const [dd, setDd] = useState<DrydockPicture | null>(null);
  const [git, setGit] = useState<ProjectDetail | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [usage, setUsage] = useState<UsageMsg | null>(null);
  const sampler = useRef<ProcSampler | null>(null);
  if (!sampler.current) sampler.current = new ProcSampler();
  // First scan in the first render: an empty first frame paints torn rows (ui.md).
  const [scan, setScan] = useState<ProcScan>(() => sampler.current!.scan());
  const [wsl, setWsl] = useState<WslServer[]>([]);
  const [, setJobsRev] = useState(0);
  const [sel, setSel] = useState<RowId | null>(null);
  const [prismaTargetId, setPrismaTargetId] = useState<string | null>(null);
  const [schemaIdx, setSchemaIdx] = useState(0);
  const [consoleId, setConsoleId] = useState<number | null>(null);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [side, setSide] = useState<"project" | "activity">("project");
  const [frame, setFrame] = useState(0);
  const lastIndex = useRef(0);
  const mounted = useRef(true);

  const say = (text: string, color: string) => setFlash({ text, color, until: Date.now() + FLASH_MS });
  const fail = (err: unknown) => say(`✗ ${err instanceof Error ? err.message : String(err)}`, T.red);

  // ─── loading ───────────────────────────────────────────────────────────────
  const probeOne = (t: DbTarget) => {
    setProbes((p) => ({ ...p, [t.id]: "probing" }));
    void probeTarget(project.dir, t).then((r) => {
      if (mounted.current) setProbes((p) => ({ ...p, [t.id]: r }));
    });
  };

  const load = () => {
    void (async () => {
      const d = await discover(project.dir);
      if (!mounted.current) return;
      setDisc(d);
      setStat(staticPicture(project.dir, d));
      setTargets(buildTargets(d.databases, cachedAppNames(project.name)));
      void inspectProject(project.dir).then((g) => mounted.current && setGit(g));
      void recentCommits(project.dir).then((c) => mounted.current && setCommits(c));
      const drydock = await loadDrydock(project.name);
      if (!mounted.current) return;
      setDd(drydock);
      const ts = buildTargets(
        d.databases,
        drydock.apps.filter((a) => a.database).map((a) => a.name),
      );
      setTargets(ts);
      for (const t of ts) probeOne(t);
    })();
  };

  useEffect(() => {
    mounted.current = true;
    load();
    void projectUsage(project.name).then((u) => mounted.current && setUsage(u));
    const t = setInterval(() => setScan(sampler.current!.scan()), SCAN_MS);
    const unsub = jobs.subscribe(() => setJobsRev((r) => r + 1));
    // A W:\ project's servers run in WSL, which the Windows scan can't see.
    let wslTimer: ReturnType<typeof setTimeout> | null = null;
    const pollWsl = () => {
      void wslServers().then((list) => {
        if (!mounted.current) return;
        if (list) setWsl(list);
        wslTimer = setTimeout(pollWsl, WSL_MS);
      });
    };
    if (IS_WIN && winToLinux(project.dir)) pollWsl();
    return () => {
      mounted.current = false;
      clearInterval(t);
      if (wslTimer) clearTimeout(wslTimer);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.dir]);

  const projJobs = jobs.list(project.dir);
  const anyProbing = Object.values(probes).some((p) => p === "probing");
  const anyStarting = projJobs.some((j) => j.phase === "starting");
  const busy = anyProbing || anyStarting || disc === null;
  // The spinner tick runs only while something is in flight (cliffnotes: never re-render on a standing timer).
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [busy]);
  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";

  const now = Date.now();
  if (armed && armed.until < now) setArmed(null);
  if (flash && flash.until < now) setFlash(null);

  // ─── derived ───────────────────────────────────────────────────────────────
  const panelPids = new Set(projJobs.map((j) => j.pid));
  const servers = projectServers(scan, project.dir, panelPids, wsl);
  const sessions = projectSessions(scan, project.dir);
  const schemas = stat?.schemas ?? [];
  const schema = schemas[Math.min(schemaIdx, Math.max(0, schemas.length - 1))] ?? null;
  const prismaTarget = targets.find((t) => t.id === prismaTargetId) ?? targets.find((t) => t.kind === "local") ?? targets[0] ?? null;
  const consoleJob = projJobs.find((j) => j.id === consoleId) ?? projJobs[projJobs.length - 1] ?? null;

  const rowIds: RowId[] = [...servers.map((s): RowId => `srv:${s.key}`), ...targets.map((t): RowId => `db:${t.id}`)];
  const found = sel ? rowIds.indexOf(sel) : -1;
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, rowIds.length - 1));
  lastIndex.current = index;
  const current = rowIds[index] ?? null;
  const select = (i: number) => {
    const id = rowIds[Math.min(Math.max(0, i), rowIds.length - 1)];
    if (id) setSel(id);
  };

  // ─── actions ───────────────────────────────────────────────────────────────
  /** First press arms (status line says what happens), second within ARM_MS fires. */
  const twoPress = (id: string, text: string, fire: () => void) => {
    if (armed?.id === id) {
      setArmed(null);
      fire();
      return;
    }
    setArmed({ id, text, fire, until: Date.now() + ARM_MS });
  };

  const openUrl = (url: string) => {
    openInChrome(url);
    say(`↗ opened ${url}`, T.cyan);
  };

  const killServer = (s: ProjectServer) =>
    twoPress(`kill:${s.key}`, `⚠ kill ${s.command} (${s.side === "wsl" ? "wsl " : ""}pid ${s.rootPid}, ${s.procs} process${s.procs === 1 ? "" : "es"}, ${s.ports.map((p) => `:${p}`).join(" ")}) — ✕ again`, () => {
      void killProjectServer(s).then(() => {
        say(`✓ killed ${s.command} · freed ${s.ports.map((p) => `:${p}`).join(" ")}`, T.green);
        setScan(sampler.current!.scan());
        if (s.side === "wsl") setWsl((l) => l.filter((w) => w.pid !== s.pid));
      });
    });

  const devKey = (d: DevCommand) => `dev:${d.cwd}`;
  const toggleDev = (d: DevCommand) => {
    const live = jobs.live(devKey(d));
    if (live) {
      jobs.stop(live);
      say(`■ stopped ${d.label}`, T.dim);
      return;
    }
    const job = jobs.start({ key: devKey(d), project: project.dir, kind: "dev", label: d.label, command: d.command, cwd: d.cwd });
    setConsoleId(job.id);
    say(`▶ ${d.command} in ${d.cwd}`, T.green);
  };

  const withUrl = (t: DbTarget, then: (url: string) => void) => {
    resolveUrl(project.dir, t, false).then(({ url }) => then(url), fail);
  };

  const studio = (t: DbTarget) => {
    const s = schemaFor(schemas, t);
    if (!s) return say("✗ no prisma schema in this project — studio needs one", T.red);
    const live = studioJob(s, t);
    const run = () =>
      withUrl(t, (url) => {
        void openStudio(project.dir, s, t, url).then((job) => {
          setConsoleId(job.id);
          say(live ? `↗ studio for ${t.label}` : `◧ starting prisma studio on ${t.label} — opens in chrome when it's up`, T.cyan);
        }, fail);
      });
    if (t.kind === "local" || live) return run();
    twoPress(`studio:${t.id}`, `⚠ studio on ${t.label}: edits write straight to that database — ◧ again`, run);
  };

  const tunnel = (t: DbTarget) => {
    if (!t.app) return;
    const live = tunnelJob(t.app);
    if (live) {
      jobs.stop(live);
      say(`■ closed the tunnel to ${t.app}`, T.dim);
      probeOne(t);
      return;
    }
    const why = tunnelUnavailable();
    if (why) return say(`✗ tunnel ${why}`, T.red);
    const app = t.app;
    say(`⇄ opening an ssm tunnel to ${app}…`, T.yellow);
    void reachOf(app)
      .then((reach) => {
        if (!reach) throw new Error(`${app} has no database on drydock`);
        return openTunnel(project.dir, app, reach);
      })
      .then(() => {
        say(`✓ tunnel to ${app} is up`, T.green);
        probeOne(t);
      }, fail);
  };

  const backup = (t: DbTarget) => withUrl(t, (url) => go({ name: "backup", presetUrl: url, presetLabel: t.label, presetDir: project.dir }));
  const pull = (t: DbTarget) =>
    withUrl(t, (url) => go({ name: "pull", preset: { envPath: t.source, dir: project.dir, rel: ".", key: t.envKey, url, redacted: redactUrl(url) } }));

  const runPrisma = (a: PrismaAction) => {
    if (!schema) return;
    const t = prismaTarget;
    const cli = prismaCli(schema.pm);
    const env = (url: string | null): Record<string, string> => (url ? { [schema.urlEnv]: url } : {});
    if (a.id === "generate" && !t) {
      const job = jobs.start({ key: `prisma:${schema.pkgDir}:generate`, project: project.dir, kind: "prisma", label: "prisma generate", command: `${cli} generate`, cwd: schema.pkgDir });
      return setConsoleId(job.id);
    }
    if (!t) return say("✗ no database to run that against — add a DATABASE_URL to .env", T.red);
    const remote = t.kind !== "local";
    if (a.remote === "never" && remote) return say(`✗ ${a.label} is for your local database only — it can reset the one it points at`, T.red);
    const fire = () =>
      withUrl(t, (url) => {
        if (a.id === "dev") {
          // migrate dev prompts (migration name, resets), so it gets a real terminal.
          term.create("shell", schema.pkgDir, 100, 30, { command: `${cli} migrate dev`, env: env(url), title: `migrate dev · ${project.name}` });
          go({ name: "term" });
          return;
        }
        const job = jobs.start({
          key: `prisma:${schema.pkgDir}:${a.id}:${t.id}`,
          project: project.dir,
          kind: "prisma",
          label: `${a.label} · ${shortLabel(t)}`,
          command: `${cli} ${a.args}`,
          cwd: schema.pkgDir,
          env: env(url),
          onExit: () => probeOne(t),
        });
        setConsoleId(job.id);
      });
    if (a.remote === "confirm" && remote) return twoPress(`prisma:${a.id}:${t.id}`, `⚠ ${a.label} against ${t.label} — that's ${t.kind === "drydock" ? "PRODUCTION" : "a remote database"} — press again`, fire);
    fire();
  };

  const newPane = (kind: "claude" | "shell") => {
    term.create(kind, project.dir);
    go({ name: "term" });
  };

  const rescan = () => {
    setScan(sampler.current!.scan());
    load();
    say("↻ rescanned", T.dim);
  };

  const primary = (id: RowId | null) => {
    if (!id) return;
    if (id.startsWith("srv:")) {
      const s = servers.find((x) => `srv:${x.key}` === id);
      if (s?.ports[0]) openUrl(`http://localhost:${s.ports[0]}`);
    } else {
      const t = targets.find((x) => `db:${x.id}` === id);
      if (t) studio(t);
    }
  };

  const twoCol = width >= TWO_COL;
  useKeyboard((key) => {
    if (key.ctrl) return;
    if (key.name === "escape") {
      if (armed) return setArmed(null);
      return back();
    }
    if (key.name === "up") return select(index - 1);
    if (key.name === "down") return select(index + 1);
    if (key.name === "return") return primary(current);
    if (key.name === "tab" && !twoCol) return setSide((s) => (s === "project" ? "activity" : "project"));
    if (key.sequence === "r") return rescan();
  });

  // ─── geometry (explicit everywhere: nothing may size to its content) ──────
  const leftW = twoCol ? Math.floor(width * 0.6) : width - 2;
  const rightW = twoCol ? width - leftW - 3 : width - 2;
  const L = Math.max(10, height - 7); // header 3, border 2, bottom margin 1, footer 1
  const showLeft = twoCol || side === "project";
  const showRight = twoCol || side === "activity";

  const footer = (
    <Footer
      hints={[
        ["click", "anything"],
        ["↑↓", "select"],
        ["enter", "open"],
        ...(twoCol ? [] : ([["tab", side === "project" ? "activity" : "project"]] as [string, string][])),
        ["esc", armed ? "disarm" : "back"],
      ]}
    />
  );

  const status = armed ? { text: armed.text, color: T.red } : flash ? { text: flash.text, color: flash.color } : null;
  const trailing: BarItem[] = [btn("↻ rescan", T.cyan, rescan), btn("≡ utilities", T.purple, () => go({ name: "menu" })), btn("← back", T.dim, back)];
  const sideSeg: BarItem[] = twoCol ? [] : [seg("", ["project", "activity"], side, setSide)];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        {showLeft && (
          <LeftPanel
            width={leftW}
            lines={L}
            project={project}
            disc={disc}
            stat={stat}
            git={git}
            dd={dd}
            servers={servers}
            targets={targets}
            probes={probes}
            schema={schema}
            schemas={schemas}
            setSchemaIdx={setSchemaIdx}
            prismaTarget={prismaTarget}
            setPrismaTarget={(t) => setPrismaTargetId(t.id)}
            jobsList={projJobs}
            consoleJob={consoleJob}
            setConsoleId={setConsoleId}
            current={current}
            armed={armed}
            spin={spin}
            status={status}
            sideSeg={sideSeg}
            trailing={trailing}
            twoCol={twoCol}
            on={{
              hover: setSel,
              openUrl,
              killServer,
              toggleDev,
              studio,
              tunnel,
              backup,
              pull,
              runPrisma,
            }}
          />
        )}
        {showRight && (
          <RightPanel
            width={rightW}
            lines={L}
            project={project}
            git={git}
            commits={commits}
            sessions={sessions}
            usage={usage}
            dd={dd}
            stat={stat}
            twoCol={twoCol}
            status={status}
            sideSeg={sideSeg}
            trailing={trailing}
            on={{ openUrl, newPane }}
          />
        )}
      </box>
      {footer}
    </box>
  );
}

// ─── left: servers, databases, prisma, console ────────────────────────────────

interface LeftProps {
  width: number;
  lines: number;
  project: ProjectRef;
  disc: Discovery | null;
  stat: StaticPicture | null;
  git: ProjectDetail | null;
  dd: DrydockPicture | null;
  servers: ProjectServer[];
  targets: DbTarget[];
  probes: Record<string, Probing>;
  schema: PrismaSchema | null;
  schemas: PrismaSchema[];
  setSchemaIdx: (i: number) => void;
  prismaTarget: DbTarget | null;
  setPrismaTarget: (t: DbTarget) => void;
  jobsList: Job[];
  consoleJob: Job | null;
  setConsoleId: (id: number) => void;
  current: RowId | null;
  armed: Armed | null;
  spin: string;
  status: { text: string; color: string } | null;
  sideSeg: BarItem[];
  trailing: BarItem[];
  twoCol: boolean;
  on: {
    hover: (id: RowId) => void;
    openUrl: (url: string) => void;
    killServer: (s: ProjectServer) => void;
    toggleDev: (d: DevCommand) => void;
    studio: (t: DbTarget) => void;
    tunnel: (t: DbTarget) => void;
    backup: (t: DbTarget) => void;
    pull: (t: DbTarget) => void;
    runPrisma: (a: PrismaAction) => void;
  };
}

function panelStyle(width: number, armed: boolean, right: boolean) {
  return {
    width,
    flexShrink: 0,
    flexDirection: "column" as const,
    border: true,
    borderStyle: "rounded" as const,
    borderColor: armed ? T.red : T.border,
    titleColor: ACCENT,
    margin: 1,
    marginTop: 0,
    marginRight: right ? 1 : 0,
    padding: 1,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: T.panel,
  };
}

function LeftPanel(p: LeftProps) {
  const inner = p.width - 4;
  const gap = p.lines >= 34 ? 1 : 0;
  const fixed = 8 + 4 * gap;
  const rest = Math.max(3, p.lines - fixed);
  let D = Math.min(Math.max(1, p.targets.length), 5);
  let S = Math.min(Math.max(1, p.servers.length), 6);
  while (rest - S - D < 3 && S > 1) S--;
  while (rest - S - D < 3 && D > 1) D--;
  const C = Math.max(1, rest - S - D);

  const dev = p.stat?.dev ?? [];
  const devItems: BarItem[] = dev.slice(0, 3).map((d) => {
    const live = jobs.live(`dev:${d.cwd}`);
    return btn(live ? `■ ${d.label}` : `▶ ${d.label}`, live ? T.red : T.green, () => p.on.toggleDev(d));
  });

  const srvRows = p.servers.length > S ? p.servers.slice(0, S - 1) : p.servers;
  const moreSrv = p.servers.length - srvRows.length;

  const blank = (k: string) => (gap ? <text key={k} fg={T.dim}>{pad("", inner)}</text> : null);

  return (
    <box title={` ⌂ ${p.project.name} `} style={panelStyle(p.width, p.armed !== null, !p.twoCol)}>
      <Summary width={inner} project={p.project} disc={p.disc} git={p.git} dd={p.dd} schema={p.schema} spin={p.spin} />
      {blank("g1")}
      <SectionBar width={inner} label="servers" note={p.servers.length ? `${p.servers.length} listening` : ""} items={devItems} />
      <box style={{ flexDirection: "column", height: S, width: inner, flexShrink: 0 }}>
        {p.servers.length === 0 ? (
          <text fg={T.dim}>{pad("nothing listening for this project", inner)}</text>
        ) : (
          srvRows.map((s) => (
            <ServerRow
              key={s.key}
              s={s}
              width={inner}
              selected={p.current === `srv:${s.key}`}
              armed={p.armed?.id === `kill:${s.key}`}
              spin={p.spin}
              onHover={() => p.on.hover(`srv:${s.key}`)}
              onOpen={() => s.ports[0] && p.on.openUrl(`http://localhost:${s.ports[0]}`)}
              onKill={() => p.on.killServer(s)}
            />
          ))
        )}
        {moreSrv > 0 ? <text fg={T.dim}>{pad(`  + ${moreSrv} more — the localhost screen has them all`, inner)}</text> : null}
      </box>
      {blank("g2")}
      <SectionBar width={inner} label="databases" note={p.targets.length ? "" : ""} items={[]} />
      <box style={{ flexDirection: "column", height: D, width: inner, flexShrink: 0 }}>
        {p.targets.length === 0 ? (
          <text fg={T.dim}>{pad(p.disc ? "no DATABASE_URL in any .env, and no Drydock database" : `${p.spin} scanning…`, inner)}</text>
        ) : (
          p.targets.slice(0, D).map((t) => (
            <TargetRow
              key={t.id}
              t={t}
              width={inner}
              probe={p.probes[t.id]}
              schema={schemaFor(p.schemas, t)}
              selected={p.current === `db:${t.id}`}
              armed={p.armed?.id === `studio:${t.id}`}
              spin={p.spin}
              onHover={() => p.on.hover(`db:${t.id}`)}
              on={p.on}
            />
          ))
        )}
      </box>
      {blank("g3")}
      <PrismaLine width={inner} schema={p.schema} schemas={p.schemas} setSchemaIdx={p.setSchemaIdx} />
      <PrismaBar width={inner} schema={p.schema} targets={p.targets} target={p.prismaTarget} setTarget={p.setPrismaTarget} armed={p.armed} run={p.on.runPrisma} />
      {blank("g4")}
      <ConsoleBar width={inner} jobs={p.jobsList} current={p.consoleJob} pick={p.setConsoleId} openUrl={p.on.openUrl} />
      <Console width={inner} height={C} job={p.consoleJob} />
      <ActionBar width={inner} items={p.sideSeg} trailing={p.trailing} />
      <text fg={p.status?.color ?? T.dim}>{pad(p.status?.text ?? statusText(p.servers, p.targets, p.jobsList), inner)}</text>
    </box>
  );
}

function statusText(servers: ProjectServer[], targets: DbTarget[], list: Job[]): string {
  const live = list.filter((j) => jobs.isAlive(j)).length;
  return `${servers.length} server${servers.length === 1 ? "" : "s"} · ${targets.length} database${targets.length === 1 ? "" : "s"} · ${live} job${live === 1 ? "" : "s"} running · live, every ${SCAN_MS / 1000}s`;
}

function Summary({ width, project, disc, git, dd, schema, spin }: { width: number; project: ProjectRef; disc: Discovery | null; git: ProjectDetail | null; dd: DrydockPicture | null; schema: PrismaSchema | null; spin: string }) {
  const root = disc?.packages.find((p) => p.rel === ".");
  const parts: { t: string; c: string }[] = [];
  if (!disc) parts.push({ t: `${spin} reading ${project.dir}`, c: T.yellow });
  if (root) parts.push({ t: root.name, c: T.fg }, { t: ` · ${root.pm}`, c: T.dim });
  if (disc && disc.packages.length > 1) parts.push({ t: ` · ${disc.packages.length} packages`, c: T.dim });
  if (git?.branch) parts.push({ t: ` · ⎇ ${git.branch}`, c: T.purple });
  if (git && (git.ahead || git.behind)) parts.push({ t: ` ↑${git.ahead} ↓${git.behind}`, c: T.yellow });
  if (git && git.dirty) parts.push({ t: ` · ${git.dirty} dirty`, c: T.orange });
  if (schema) parts.push({ t: ` · prisma ${schema.version?.replace(/^[\^~]/, "") ?? ""}`.trimEnd(), c: T.teal });
  for (const a of dd?.apps ?? []) parts.push({ t: ` · ◆ ${a.name} ${a.running}/${a.desired}`, c: a.running >= Math.max(1, a.desired) ? T.green : T.red });
  let used = 0;
  return (
    <text>
      {parts.map((x, i) => {
        const room = Math.max(0, width - used);
        const t = fit(x.t, room);
        used += t.length;
        return (
          <span key={i} fg={x.c}>
            {t}
          </span>
        );
      })}
      <span>{" ".repeat(Math.max(0, width - used))}</span>
    </text>
  );
}

/** A dim section label with its own buttons on the same row. */
function SectionBar({ width, label, note, items }: { width: number; label: string; note: string; items: BarItem[] }) {
  const labelW = Math.min(width, Math.max(label.length + note.length + 4, 22));
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <box style={{ height: 1, width: labelW }}>
        <text>
          <span fg={ACCENT}>{label}</span>
          <span fg={T.dim}>{pad(note ? `  ${note}` : "", labelW - label.length)}</span>
        </text>
      </box>
      <ActionBar width={width - labelW} items={items} trailing={[]} />
    </box>
  );
}

/** Fixed-width button on a row — a box that resizes leaves paint behind. */
function RowBtn({ label, color, width, hot = false, onPress }: { label: string; color: string; width: number; hot?: boolean; onPress: () => void }) {
  return (
    <box
      style={{ width, height: 1, flexShrink: 0, backgroundColor: hot ? T.red : T.surfaceAlt }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onPress();
      }}
    >
      <text fg={hot ? T.bg : color}>{pad(` ${label}`, width)}</text>
    </box>
  );
}

const PORT_W = 9;
const OWNER_W = 18;
const UP_W = 5;
const MEM_W = 6;

function ownerColor(kind: ProjectServer["owner"]["kind"]): string {
  return kind === "session" ? T.purple : kind === "panel" ? T.teal : kind === "orphan" ? T.orange : kind === "wsl" ? T.cyan : T.dim;
}

function ServerRow({ s, width, selected, armed, spin, onHover, onOpen, onKill }: { s: ProjectServer; width: number; selected: boolean; armed: boolean; spin: string; onHover: () => void; onOpen: () => void; onKill: () => void }) {
  const port = s.ports[0] ?? 0;
  const pr = probe(s.pid, port);
  const dot = health(pr, spin);
  const extra = s.ports.length > 1 ? `+${s.ports.length - 1}` : "";
  const btnW = 3 + 1 + 4;
  const ownerW = Math.min(OWNER_W, Math.max(8, Math.floor(width / 6)));
  const midW = Math.max(8, width - 2 - 2 - PORT_W - ownerW - UP_W - MEM_W - 1 - btnW);
  const title = pr?.title ? ` “${pr.title}” ` : " ";
  const mid = `${s.sub ? `${s.sub} · ` : ""}${s.command}`;
  const titleText = fit(title, Math.floor(midW * 0.5));
  const bg = armed ? T.surface : selected ? T.selectionBg : T.panel;
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={onOpen}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={dot.color}>{`${dot.glyph} `}</span>
        <span fg={selected ? ACCENT : T.fg}>{pad(`:${port}`, PORT_W - extra.length)}</span>
        <span fg={T.dim}>{extra}</span>
        <span fg={T.fg}>{titleText}</span>
        <span fg={selected ? T.fg : T.dim}>{pad(mid, midW - titleText.length)}</span>
        <span fg={ownerColor(s.owner.kind)}>{pad(` ${s.owner.label}`, ownerW)}</span>
        <span fg={T.dim}>{fmtUp(s.startedAt).padStart(UP_W)}</span>
        <span fg={memColor(s.memory)}>{fmtMem(s.memory).padStart(MEM_W)}</span>
        <span>{" "}</span>
      </text>
      <RowBtn label="↗" color={T.cyan} width={3} onPress={onOpen} />
      <box style={{ width: 1, height: 1 }} />
      <RowBtn label={armed ? "✕?" : "✕"} color={T.red} width={4} hot={armed} onPress={onKill} />
    </box>
  );
}

function shortLabel(t: DbTarget): string {
  if (t.kind === "drydock") return "prod";
  if (t.kind === "local") return t.label.startsWith(".env") && t.label !== ".env" ? t.label : "local";
  return t.label;
}

function TargetRow({
  t,
  width,
  probe: pr,
  schema,
  selected,
  armed,
  spin,
  onHover,
  on,
}: {
  t: DbTarget;
  width: number;
  probe: Probing | undefined;
  schema: PrismaSchema | null;
  selected: boolean;
  armed: boolean;
  spin: string;
  onHover: () => void;
  on: LeftProps["on"];
}) {
  const live = t.app ? tunnelJob(t.app) : null;
  const closed = typeof pr === "object" && !pr.probe.ok && t.kind === "drydock" && /isn't open|tunnel/i.test(pr.probe.error ?? "");
  const showTunnel = t.kind === "drydock" && (closed || live !== null);
  const studioLive = schema ? studioJob(schema, t) : null;
  const btns: { label: string; color: string; w: number; hot?: boolean; press: () => void }[] = [];
  if (showTunnel) btns.push({ label: live ? "■ tunnel" : "⇄ tunnel", color: live ? T.red : T.yellow, w: 10, press: () => on.tunnel(t) });
  if (schema) btns.push({ label: armed ? "◧ studio?" : studioLive ? "↗ studio" : "◧ studio", color: T.cyan, w: 11, hot: armed, press: () => on.studio(t) });
  btns.push({ label: "⛁", color: T.blue, w: 3, press: () => on.backup(t) });
  if (t.kind !== "local") btns.push({ label: "⇩ pull", color: T.green, w: 8, press: () => on.pull(t) });
  const btnW = btns.reduce((n, b) => n + b.w + 1, 0);
  const labelW = Math.min(26, Math.max(14, Math.floor(width * 0.24)));
  const midW = Math.max(6, width - 4 - labelW - btnW);

  let dot: { glyph: string; color: string } = { glyph: "○", color: T.dim };
  let text = "";
  let color: string = T.dim;
  if (pr === undefined) text = "…";
  else if (pr === "probing") {
    dot = { glyph: spin, color: T.yellow };
    text = "probing…";
  } else if (pr.probe.ok) {
    dot = { glyph: "●", color: T.green };
    const via = t.kind === "drydock" ? (pr.mode === "tunnel" ? "via tunnel · " : "direct · ") : "";
    text = `${via}${t.where || ""}${t.where ? " · " : ""}pg ${pr.probe.version ?? "?"} · ${pr.probe.bytes !== null ? fmtBytes(pr.probe.bytes) : "?"} · ${pr.probe.tables ?? "?"} tables`;
    color = T.fg;
  } else {
    dot = closed ? { glyph: "○", color: T.yellow } : { glyph: "✕", color: T.red };
    text = `${t.where ? `${t.where} · ` : ""}${pr.probe.error ?? "unreachable"}`;
    color = closed ? T.yellow : T.red;
  }
  const mig = typeof pr === "object" && pr.probe.ok ? migrationNote(schema, pr) : null;
  const migText = mig ? fit(` · ${mig.text}`, Math.max(0, Math.floor(midW * 0.4))) : "";
  const bg = selected ? T.selectionBg : T.panel;
  const labelColor = t.kind === "drydock" ? T.orange : t.kind === "remote" ? T.yellow : T.fg;
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: bg }} onMouseOver={onHover} onMouseDown={() => on.studio(t)}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={dot.color}>{`${dot.glyph} `}</span>
        <span fg={labelColor}>{pad(t.label, labelW)}</span>
        <span fg={color}>{fit(text, midW - migText.length)}</span>
        <span fg={mig?.color ?? T.dim}>{pad(migText, midW - fit(text, midW - migText.length).length)}</span>
      </text>
      {btns.map((b) => (
        <box key={b.label} style={{ flexDirection: "row", height: 1, width: b.w + 1, flexShrink: 0 }}>
          <box style={{ width: 1, height: 1 }} />
          <RowBtn label={b.label} color={b.color} width={b.w} hot={b.hot} onPress={b.press} />
        </box>
      ))}
    </box>
  );
}

function migrationNote(schema: PrismaSchema | null, pr: TargetProbe): { text: string; color: string } | null {
  if (!schema) return null;
  const applied = pr.probe.applied;
  if (schema.migrations.length === 0) return { text: applied ? `${applied.length} applied, repo has none` : "db push", color: T.dim };
  if (!applied) return { text: "no _prisma_migrations", color: T.yellow };
  const d = diffMigrations(schema.migrations, applied);
  if (pr.probe.failed) return { text: `${pr.probe.failed} failed`, color: T.red };
  if (d.pending.length) return { text: `${d.pending.length} pending`, color: T.yellow };
  if (d.unknown.length) return { text: `${d.unknown.length} not in repo`, color: T.orange };
  return { text: "migrations ✓", color: T.green };
}

function PrismaLine({ width, schema, schemas, setSchemaIdx }: { width: number; schema: PrismaSchema | null; schemas: PrismaSchema[]; setSchemaIdx: (i: number) => void }) {
  if (!schema) {
    return (
      <text>
        <span fg={ACCENT}>{"prisma"}</span>
        <span fg={T.dim}>{pad("  no schema in this project", width - 6)}</span>
      </text>
    );
  }
  const where = schema.schemaPath.slice(schema.pkgDir.length + 1).replace(/\\/g, "/");
  const info = `  ${schema.rel === "." ? "" : `${schema.rel.replace(/\\/g, "/")}/`}${where} · ${schema.models.length} models${schema.enums ? ` · ${schema.enums} enums` : ""} · ${schema.migrations.length ? `${schema.migrations.length} migrations` : "db push"} · ${schema.provider ?? "?"}${schema.config ? " · prisma.config" : ""}`;
  if (schemas.length < 2) {
    return (
      <text>
        <span fg={ACCENT}>{"prisma"}</span>
        <span fg={T.fg}>{pad(info, width - 6)}</span>
      </text>
    );
  }
  const names = schemas.map((s, i) => String(i));
  const segItem = seg("", names, String(schemas.indexOf(schema)), (v) => setSchemaIdx(Number(v)), Object.fromEntries(schemas.map((s, i) => [String(i), s.rel === "." ? "root" : s.rel.replace(/\\/g, "/")])));
  const segW = schemas.reduce((n, s) => n + (s.rel === "." ? 4 : s.rel.length) + 2, 0) + 1;
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <box style={{ height: 1, width: width - segW }}>
        <text>
          <span fg={ACCENT}>{"prisma"}</span>
          <span fg={T.fg}>{pad(info, width - segW - 6)}</span>
        </text>
      </box>
      <ActionBar width={segW} items={[segItem]} trailing={[]} />
    </box>
  );
}

function PrismaBar({ width, schema, targets, target, setTarget, armed, run }: { width: number; schema: PrismaSchema | null; targets: DbTarget[]; target: DbTarget | null; setTarget: (t: DbTarget) => void; armed: Armed | null; run: (a: PrismaAction) => void }) {
  if (!schema) return <text>{pad("", width)}</text>;
  const items: BarItem[] = [];
  if (targets.length > 1 && target) {
    items.push(seg("on", targets.map((t) => t.id), target.id, (id) => {
      const t = targets.find((x) => x.id === id);
      if (t) setTarget(t);
    }, Object.fromEntries(targets.map((t) => [t.id, shortLabel(t)]))));
  } else if (target) items.push({ kind: "seg", label: "on", options: [{ label: shortLabel(target), active: true, onPress: () => {} }] });
  const remote = target ? target.kind !== "local" : false;
  for (const a of PRISMA_ACTIONS) {
    if (a.needsMigrations && schema.migrations.length === 0) continue;
    if (a.remote === "never" && remote) continue;
    const isArmed = armed?.id === `prisma:${a.id}:${target?.id ?? ""}`;
    const color = isArmed ? T.red : a.remote === "confirm" && remote ? T.orange : a.id === "generate" || a.id === "status" ? T.cyan : T.green;
    items.push(btn(isArmed ? `⚠ ${a.label}?` : a.label, color, () => run(a)));
  }
  return <ActionBar width={width} items={items} trailing={[]} />;
}

function jobGlyph(j: Job, spin: string): string {
  switch (j.phase) {
    case "starting":
      return spin;
    case "ready":
    case "running":
      return "●";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "stopped":
      return "■";
  }
}

function ConsoleBar({ width, jobs: list, current, pick, openUrl }: { width: number; jobs: Job[]; current: Job | null; pick: (id: number) => void; openUrl: (url: string) => void }) {
  const items: BarItem[] = [];
  if (list.length) {
    const ids = list.map((j) => String(j.id));
    items.push(seg("", ids, String(current?.id ?? ""), (v) => pick(Number(v)), Object.fromEntries(list.map((j) => [String(j.id), `${jobGlyph(j, "…")} ${fit(j.spec.label, 26)}`]))));
  }
  const trailing: BarItem[] = [];
  if (current) {
    if (current.spec.kind === "studio" && current.phase === "ready" && current.spec.readyPort) {
      const url = `http://localhost:${current.spec.readyPort}`;
      trailing.push(btn("↗ open", T.cyan, () => openUrl(url)));
    }
    if (jobs.isAlive(current)) trailing.push(btn("■ stop", T.red, () => jobs.stop(current)));
    else trailing.push(btn("✕ clear", T.dim, () => jobs.dismiss(current)));
  }
  const labelW = 9;
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <box style={{ height: 1, width: labelW }}>
        <text>
          <span fg={ACCENT}>{"console"}</span>
          <span>{"  "}</span>
        </text>
      </box>
      <ActionBar width={width - labelW} items={items} trailing={trailing} />
    </box>
  );
}

function Console({ width, height, job }: { width: number; height: number; job: Job | null }) {
  const shown = job ? job.lines.slice(-height) : [];
  const first = job ? job.total - shown.length : 0;
  return (
    <box style={{ flexDirection: "column", height, width, flexShrink: 0, backgroundColor: T.bg }}>
      {job ? (
        shown.map((l, i) => (
          <text key={first + i} fg={l.stream === "info" ? T.cyan : l.stream === "stderr" ? T.orange : T.fg}>
            {pad(` ${l.text}`, width)}
          </text>
        ))
      ) : (
        <text fg={T.dim}>{pad(" no jobs yet", width)}</text>
      )}
    </box>
  );
}

// ─── right: git, claude, drydock, env ─────────────────────────────────────────

function RightPanel({
  width,
  lines,
  project,
  git,
  commits,
  sessions,
  usage,
  dd,
  stat,
  twoCol,
  status,
  sideSeg,
  trailing,
  on,
}: {
  width: number;
  lines: number;
  project: ProjectRef;
  git: ProjectDetail | null;
  commits: Commit[];
  sessions: Group[];
  usage: UsageMsg | null;
  dd: DrydockPicture | null;
  stat: StaticPicture | null;
  twoCol: boolean;
  status: { text: string; color: string } | null;
  sideSeg: BarItem[];
  trailing: BarItem[];
  on: { openUrl: (url: string) => void; newPane: (k: "claude" | "shell") => void };
}) {
  const inner = width - 4;
  const rows: { key: string; node: React.ReactNode }[] = [];
  const line = (key: string, text: string, color: string = T.dim) => rows.push({ key, node: <text fg={color}>{pad(text, inner)}</text> });
  const head = (key: string, label: string, items: BarItem[] = []) => rows.push({ key, node: <SectionBar width={inner} label={label} note="" items={items} /> });

  // git
  head("git", "git");
  if (!git) line("git0", "  reading…");
  else if (git.error) line("git0", `  ${git.error}`);
  else {
    const track = git.upstream ? ` · ${git.upstream}${git.ahead || git.behind ? ` ↑${git.ahead} ↓${git.behind}` : " ✓"}` : " · no upstream";
    rows.push({
      key: "git0",
      node: (
        <text>
          <span fg={T.purple}>{`  ⎇ ${git.branch ?? "?"}`}</span>
          <span fg={git.ahead || git.behind ? T.yellow : T.dim}>{track}</span>
          <span fg={git.dirty ? T.orange : T.green}>{pad(git.dirty ? ` · ${git.dirty} dirty` : " · clean", Math.max(0, inner - 4 - (git.branch ?? "?").length - track.length))}</span>
        </text>
      ),
    });
  }
  for (const c of commits.slice(0, 5)) {
    rows.push({
      key: `c${c.hash}`,
      node: (
        <text>
          <span fg={T.cyan}>{`  ${c.hash} `}</span>
          <span fg={T.fg}>{fit(c.subject, Math.max(4, inner - c.hash.length - 4 - c.when.length - 2))}</span>
          <span fg={T.dim}>{pad(`  ${c.when}`, Math.max(0, inner - c.hash.length - 3 - fit(c.subject, Math.max(4, inner - c.hash.length - 4 - c.when.length - 2)).length))}</span>
        </text>
      ),
    });
  }
  line("b1", "");

  // claude
  head("claude", "claude", [btn("✦ claude here", T.purple, () => on.newPane("claude")), btn("▓ shell", T.teal, () => on.newPane("shell"))]);
  if (sessions.length === 0) line("s0", "  no session working here right now");
  for (const g of sessions.slice(0, 4)) {
    const s = g.session;
    const busy = s?.status === "busy" || (s?.cardState ?? "") === "working";
    rows.push({
      key: `s${g.key}`,
      node: (
        <text>
          <span fg={busy ? T.yellow : T.dim}>{"  ● "}</span>
          <span fg={T.fg}>{fit(s?.label || s?.name || "claude", 28)}</span>
          <span fg={T.dim}>{pad(s?.now ? `  ${s.now}` : "", Math.max(0, inner - 4 - fit(s?.label || s?.name || "claude", 28).length))}</span>
        </text>
      ),
    });
  }
  if (!usage) line("u0", "  reading usage…");
  else if (usage.type === "usage") {
    const week = `$${usage.week.toFixed(2)}`;
    const month = `$${usage.month.toFixed(2)}`;
    const tail = ` 30d · ${usage.sessions30} session${usage.sessions30 === 1 ? "" : "s"} · last ${usage.lastTs ? ago(usage.lastTs * 1000) : "never"}  `;
    // The sparkline gets whatever the text leaves, a day per cell, newest last.
    const room = Math.max(0, inner - 2 - week.length - 6 - month.length - tail.length);
    rows.push({
      key: "u0",
      node: (
        <text>
          <span fg={T.dim}>{"  "}</span>
          <span fg={usage.week >= 50 ? T.yellow : T.fg}>{week}</span>
          <span fg={T.dim}>{" 7d · "}</span>
          <span fg={T.fg}>{month}</span>
          <span fg={T.dim}>{tail}</span>
          <span fg={T.cyan}>{pad(spark(usage.series, room), room)}</span>
        </text>
      ),
    });
  } else if (usage.type === "none") line("u0", "  no usage cache yet — open claude usage once");
  else line("u0", `  usage: ${usage.message}`, T.red);
  line("b2", "");

  // drydock
  head("drydock", "drydock");
  if (!dd) line("d0", "  asking the portal…");
  else {
    if (dd.error) line("derr", `  ${dd.error}`, T.orange);
    if (dd.apps.length === 0 && !dd.error) line("d0", `  not deployed — nothing on Drydock maps to ${project.name}`);
    for (const a of dd.apps.slice(0, 2)) {
      const d = dd.details[a.name];
      const primary = d?.state?.deployments.find((x) => x.status === "PRIMARY");
      const up = a.running >= Math.max(1, a.desired);
      const items: BarItem[] = [];
      if (a.domain) items.push(btn(`↗ ${a.domain}`, T.cyan, () => on.openUrl(`https://${a.domain}`)));
      items.push(btn("↗ portal", T.dim, () => on.openUrl("http://localhost:4400")));
      rows.push({
        key: `a${a.name}`,
        node: (
          <box style={{ flexDirection: "row", height: 1, width: inner }}>
            <box style={{ height: 1, width: Math.min(inner, 24) }}>
              <text>
                <span fg={T.orange}>{`  ◆ ${fit(a.name, 14)}`}</span>
                <span fg={up ? T.green : T.red}>{pad(` ${a.running}/${a.desired}`, Math.max(0, Math.min(inner, 24) - 4 - fit(a.name, 14).length))}</span>
              </text>
            </box>
            <ActionBar width={Math.max(0, inner - 24)} items={items} trailing={[]} />
          </box>
        ),
      });
      if (primary) line(`ad${a.name}`, `    ${primary.taskDef} · ${primary.rolloutState ?? primary.status}${primary.createdAt ? ` · ${ago(Date.parse(primary.createdAt))}` : ""}`, primary.rolloutState === "FAILED" ? T.red : T.dim);
      if (a.predeploy) line(`ap${a.name}`, `    predeploy: ${a.predeploy}`);
      if (d) {
        const local = new Set((stat?.envFiles ?? []).flatMap((f) => f.names));
        const deployed = new Set(d.envNames);
        const onlyHere = [...local].filter((n) => !deployed.has(n)).sort();
        const onlyThere = [...deployed].filter((n) => !local.has(n)).sort();
        line(`ae${a.name}`, `    ssm: ${d.envNames.length} vars${onlyHere.length ? ` · not deployed: ${onlyHere.join(" ")}` : ""}`, onlyHere.length ? T.yellow : T.dim);
        if (onlyThere.length && local.size) line(`ao${a.name}`, `    only on drydock: ${onlyThere.join(" ")}`);
      }
    }
  }
  line("b3", "");

  // env
  head("env", "env");
  const files = stat?.envFiles ?? [];
  if (!stat) line("e0", "  reading…");
  else if (files.length === 0) line("e0", "  no .env files");
  for (const f of files) {
    rows.push({
      key: `f${f.rel}`,
      node: (
        <text>
          <span fg={T.fg}>{`  ${fit(f.rel, 28)}`}</span>
          <span fg={T.dim}>{pad(`  ${f.names.length} · ${f.names.join(" ")}`, Math.max(0, inner - 2 - fit(f.rel, 28).length))}</span>
        </text>
      ),
    });
  }

  const budget = Math.max(1, lines - (twoCol ? 0 : 2));
  const shown = rows.slice(0, budget);
  return (
    <box title=" activity " style={panelStyle(width, false, true)}>
      <box style={{ flexDirection: "column", height: budget, width: inner, flexShrink: 0 }}>
        {shown.map((r) => (
          <box key={r.key} style={{ height: 1, width: inner }}>
            {r.node}
          </box>
        ))}
      </box>
      {twoCol ? null : <ActionBar width={inner} items={sideSeg} trailing={trailing} />}
      {twoCol ? null : <text fg={status?.color ?? T.dim}>{pad(status?.text ?? "", inner)}</text>}
    </box>
  );
}

// ─── formatting ───────────────────────────────────────────────────────────────

function health(p: Probe | null, spin: string): { glyph: string; color: string } {
  if (!p) return { glyph: spin, color: T.yellow };
  if (p.kind === "timeout") return { glyph: "◌", color: T.yellow };
  if (p.kind === "other") return { glyph: "○", color: T.dim };
  if ((p.status ?? 0) >= 500) return { glyph: "●", color: T.red };
  return { glyph: "●", color: T.green };
}

function memColor(bytes: number): string {
  if (bytes >= 1024 ** 3) return T.red;
  if (bytes >= 600 * 1024 ** 2) return T.yellow;
  return T.dim;
}

function fmtMem(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

function fmtUp(startedAt: number): string {
  if (!startedAt) return "";
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / 86400 / 30)}mo ago`;
}

function spark(series: number[], cells: number): string {
  const bars = "▁▂▃▄▅▆▇█";
  if (cells <= 0) return "";
  const vals = series.slice(-Math.min(30, cells));
  const max = Math.max(0, ...vals);
  if (max <= 0) return "";
  return vals.map((v) => (v <= 0 ? "·" : bars[Math.min(7, Math.floor((v / max) * 7.999))] ?? "▁")).join("");
}
