import { join } from "node:path";
import { runCommand, type OutputLine, type ProcHandle } from "./run.ts";
import { projectsRoot } from "./projects.ts";
import { T } from "../theme.ts";

/** One dev server the startup dashboard supervises. */
export interface AppSpec {
  id: string;
  /** Folder under the projects root (name may differ from the package name). */
  folder: string;
  /** Display name. */
  name: string;
  /** Resolved absolute directory (projectsRoot + folder). */
  dir: string;
  /** Shell command that starts the dev server. */
  command: string;
  /** Web apps only — the localhost URL the "open" button hits. */
  url?: string;
  /** Tauri/Electron shells open their own window; no browser button. */
  desktop: boolean;
  /** One-line descriptor shown on the card. */
  note: string;
  /** Accent colour so each app reads as itself at a glance. */
  accent: string;
}

const SPECS: Omit<AppSpec, "dir">[] = [
  { id: "todolist", folder: "sal-todo", name: "todolist", command: "npm start", url: "http://localhost:4321", desktop: false, note: "node · :4321", accent: T.green },
  { id: "deck", folder: "deck", name: "deck", command: "bun run dev", url: "http://localhost:12346", desktop: false, note: "bun · :12346", accent: T.purple },
  { id: "drydock", folder: "drydock", name: "drydock", command: "bun run dev", url: "http://localhost:4400", desktop: false, note: "bun · :4400", accent: T.cyan },
  { id: "chirptime", folder: "chirptime", name: "chirptime", command: "bun run dev", desktop: true, note: "tauri · window", accent: T.orange },
  { id: "sal-widgets", folder: "sal-widgets", name: "sal-widgets", command: "bun run dev", desktop: true, note: "electron · window", accent: T.blue },
];

export const APPS: AppSpec[] = SPECS.map((s) => ({ ...s, dir: join(projectsRoot(), s.folder) }));

export type Phase = "stopped" | "booting" | "ready" | "exited" | "crashed";

export interface AppRuntime {
  spec: AppSpec;
  phase: Phase;
  lines: OutputLine[];
  handle: ProcHandle | null;
  exitCode: number | null;
  startedAt: number | null;
}

const MAX_LINES = 4000;

/**
 * A dev server is "up" the moment it says something that means it's serving.
 * Broad on purpose — every framework here (node/http, vite, tauri, electron)
 * prints one of these — and a 6s fallback timer covers anything that stays quiet.
 */
const READY_RE = /localhost|ready in|listening|compiled|Local:|running at|dev server|serving|started|:\d{4,5}\b/i;
const READY_FALLBACK_MS = 6000;

interface Internal extends AppRuntime {
  stopping: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Supervises the fleet of dev servers. Lives at module scope — not inside a
 * React component — so the processes and their scrollback survive navigating
 * away from the dashboard and back. They die only when the tui really exits
 * (killAll on process exit), which is why "leave this terminal open" works.
 */
class StartupManager {
  private apps = new Map<string, Internal>();
  /** Bumped on every mutation; the screen polls it to know when to re-render. */
  revision = 0;
  private autoStarted = false;

  constructor() {
    for (const spec of APPS) {
      this.apps.set(spec.id, {
        spec,
        phase: "stopped",
        lines: [],
        handle: null,
        exitCode: null,
        startedAt: null,
        stopping: false,
        readyTimer: null,
      });
    }
  }

  list(): AppRuntime[] {
    return APPS.map((s) => this.apps.get(s.id)!);
  }

  /** Start every stopped app — used once when the dashboard first opens. */
  autoStart(): void {
    if (this.autoStarted) return;
    this.autoStarted = true;
    this.startAll();
  }

  start(id: string): void {
    const rt = this.apps.get(id);
    if (!rt || rt.handle) return; // already running
    rt.stopping = false;
    rt.exitCode = null;
    rt.startedAt = Date.now();
    rt.phase = "booting";
    this.push(rt, { text: `▶ ${rt.spec.command}   ${rt.spec.dir}`, stream: "info" });

    const handle = runCommand(rt.spec.command, rt.spec.dir, (line) => {
      this.push(rt, line);
      if (rt.phase === "booting" && READY_RE.test(line.text)) rt.phase = "ready";
    });
    rt.handle = handle;
    rt.readyTimer = setTimeout(() => {
      if (rt.phase === "booting") {
        rt.phase = "ready";
        this.revision++;
      }
    }, READY_FALLBACK_MS);

    handle.exited.then((code) => {
      rt.handle = null;
      rt.exitCode = code;
      if (rt.readyTimer) {
        clearTimeout(rt.readyTimer);
        rt.readyTimer = null;
      }
      rt.phase = rt.stopping ? "stopped" : code === 0 ? "exited" : "crashed";
      this.push(rt, {
        text: rt.stopping ? "■ stopped" : `● process exited (code ${code})`,
        stream: "info",
      });
    });
    this.revision++;
  }

  stop(id: string): void {
    const rt = this.apps.get(id);
    if (!rt || !rt.handle) return;
    rt.stopping = true; // tells the exit handler this was intentional, not a crash
    rt.handle.kill();
  }

  restart(id: string): void {
    const rt = this.apps.get(id);
    if (!rt) return;
    if (rt.handle) {
      rt.stopping = true;
      rt.handle.exited.then(() => this.start(id));
      rt.handle.kill();
    } else {
      this.start(id);
    }
  }

  startAll(): void {
    for (const s of APPS) this.start(s.id);
  }

  stopAll(): void {
    for (const s of APPS) this.stop(s.id);
  }

  clearLog(id: string): void {
    const rt = this.apps.get(id);
    if (!rt) return;
    rt.lines = [];
    this.revision++;
  }

  private push(rt: Internal, line: OutputLine): void {
    rt.lines.push(line);
    if (rt.lines.length > MAX_LINES) rt.lines.splice(0, rt.lines.length - MAX_LINES);
    this.revision++;
  }
}

export const startup = new StartupManager();
