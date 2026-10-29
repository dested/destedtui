// What's running for one project: every listening unit whose processes work
// inside the project folder, who started it (a Claude session, you, this
// panel, or nobody any more), and the Claude sessions working there now.
// Built on the procs scan (lib/procs.ts), so it sees the same process trees.
//
// The Windows build can't see WSL's listeners (nor WSL's Windows ones), and a
// W:\ project's dev servers almost always run in WSL. For those it also reads
// the distro's own `destedtui --ports --json` (wslServers), every WSL_MS.

import { z } from "zod";
import { killRoots, type Group, type ProcScan, type Unit } from "../procs.ts";
import { prettyCommand } from "../proctext.ts";
import { IS_WIN, WSL_DISTRO, winToLinux } from "../platform.ts";
import { inside } from "./context.ts";

export type OwnerKind = "session" | "panel" | "orphan" | "you" | "wsl";

export interface ProjectServer {
  /** stable across scans */
  key: string;
  side: "windows" | "wsl";
  /** the listening process (the probe's key) */
  pid: number;
  /** the tree's root — what a kill takes down */
  rootPid: number;
  procs: number;
  startedAt: number;
  memory: number;
  ports: number[];
  owner: { kind: OwnerKind; label: string };
  command: string;
  /** the server's cwd under the project ("" = the root) */
  sub: string;
  /** Windows only: the procs unit, killed through killRoots */
  unit: Unit | null;
}

function relSub(cwd: string, dir: string): string {
  const c = cwd.replace(/[\\/]+/g, "/");
  const d = dir.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return c.length > d.length ? c.slice(d.length + 1) : "";
}

function ownerOf(g: Group, unit: Unit, panelPids: Set<number>): ProjectServer["owner"] {
  if (unit.tree.some((t) => panelPids.has(t.proc.pid))) return { kind: "panel", label: "this panel" };
  if (g.kind === "session") return { kind: "session", label: g.session?.label || g.session?.name || "claude" };
  if (g.kind === "orphans") return { kind: "orphan", label: "orphan" };
  return { kind: "you", label: "your shell" };
}

const mentionsDir = (cmdline: string, dir: string) => {
  const dirKey = `${dir.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase()}/`;
  return cmdline.replace(/[\\/]+/g, "/").toLowerCase().includes(dirKey);
};

/** Listening units for the project, lowest port first. `panelPids` = pids of jobs this panel started. */
export function projectServers(scan: ProcScan, dir: string, panelPids: Set<number>, wsl: WslServer[] = []): ProjectServer[] {
  const out: ProjectServer[] = [];
  for (const g of scan.groups) {
    for (const unit of g.units) {
      if (unit.ports.length === 0) continue;
      // cwd first; a `bun W:\code\x\src\server.ts` started from elsewhere still counts
      const here = unit.tree.find((t) => inside(t.proc.cwd, dir)) ?? (unit.tree.some((t) => mentionsDir(t.proc.cmdline, dir)) ? unit.tree[0] : undefined);
      if (!here) continue;
      const rep = unit.rep;
      out.push({
        key: unit.key,
        side: "windows",
        pid: rep.pid,
        rootPid: unit.root.pid,
        procs: unit.tree.length,
        startedAt: unit.root.startedAt,
        memory: unit.memory,
        ports: unit.ports,
        owner: ownerOf(g, unit, panelPids),
        command: prettyCommand(rep.cmdline, rep.cwd, rep.exe),
        sub: inside(here.proc.cwd, dir) ? relSub(here.proc.cwd, dir) : "",
        unit,
      });
    }
  }
  const linuxDir = IS_WIN ? winToLinux(dir) : null;
  if (linuxDir) {
    for (const s of wsl) {
      const here = inside(s.cwd, linuxDir);
      if (!here && !mentionsDir(s.cmdline, linuxDir)) continue;
      out.push({
        key: `wsl:${s.pid}:${s.startedAt}`,
        side: "wsl",
        pid: s.pid,
        rootPid: s.pid,
        procs: 1,
        startedAt: s.startedAt,
        memory: s.memory,
        ports: s.listeners.map((l) => l.port),
        owner: { kind: "wsl", label: "wsl" },
        command: prettyCommand(s.cmdline, s.cwd, s.exe),
        sub: here ? relSub(s.cwd, linuxDir) : "",
        unit: null,
      });
    }
  }
  return out.sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0));
}

/** Claude sessions whose cwd is in the project. */
export function projectSessions(scan: ProcScan, dir: string): Group[] {
  return scan.groups.filter((g) => g.kind === "session" && g.session && inside(g.session.cwd, dir));
}

// ─── WSL listeners, from the Windows build ────────────────────────────────────

/** How often the panel re-reads WSL: one scan costs a wsl.exe hop plus its probes. */
export const WSL_MS = 6000;

const wslServerSchema = z.object({
  pid: z.number(),
  exe: z.string(),
  cmdline: z.string(),
  cwd: z.string(),
  startedAt: z.number(),
  memory: z.number(),
  listeners: z.array(z.object({ port: z.number() })),
});
export type WslServer = z.infer<typeof wslServerSchema>;
const portsJsonSchema = z.object({ v: z.literal(1), servers: z.array(wslServerSchema) });

/** Run something in the distro by argv (no shell quoting in between); stdout, or null. */
async function inWsl(cmd: string[], ms: number): Promise<string | null> {
  try {
    const p = Bun.spawn(["wsl.exe", "-d", WSL_DISTRO, "--exec", ...cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), ms);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Every listener in the distro, via its own linked bin (`~/.bun/bin` isn't on
 * a login zsh's PATH, so by path). Null when WSL or the bin doesn't answer.
 */
export async function wslServers(): Promise<WslServer[] | null> {
  const out = await inWsl(["zsh", "-lc", "~/.bun/bin/destedtui --ports --json"], 10_000);
  if (!out) return null;
  try {
    const parsed = portsJsonSchema.safeParse(JSON.parse(out));
    return parsed.success ? parsed.data.servers : null;
  } catch {
    return null;
  }
}

/** Kill a server and what it started: Windows trees through killRoots, WSL ones with TERM inside the distro. */
export async function killServer(s: ProjectServer): Promise<void> {
  if (s.unit) return killRoots([s.unit]);
  const pid = String(s.rootPid);
  await inWsl(["sh", "-c", `pkill -TERM -P ${pid}; kill -TERM ${pid}`], 5000);
}
