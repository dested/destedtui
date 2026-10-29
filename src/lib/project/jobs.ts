// Everything the project panel starts: a dev server, prisma commands, Prisma
// Studio, an SSM tunnel. A module-level singleton on purpose (like `startup`):
// jobs outlive leaving the screen and die only when the TUI quits, because
// they're spawned through runCommand (tracked, tree-killed on exit, and they
// hold the idle pause off while alive).
//
// Output lines are scrubbed of postgres passwords before they're kept: a job's
// env can carry a production DATABASE_URL and some tools echo it.

import { inDistro } from "../platform.ts";
import { runCommand, type OutputLine, type ProcHandle } from "../run.ts";
import { tcpOpen } from "./db.ts";

export type JobKind = "dev" | "prisma" | "studio" | "tunnel";
export type JobPhase = "starting" | "ready" | "running" | "done" | "failed" | "stopped";

export interface JobSpec {
  /** one live job per key: starting a key that's alive returns the live one */
  key: string;
  /** project dir, so the panel lists only its own */
  project: string;
  kind: JobKind;
  label: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** ready = something answers on 127.0.0.1:<port> */
  readyPort?: number;
  /** ready = an output line matches */
  readyLine?: RegExp;
  /** called once, when it becomes ready */
  onReady?: (job: Job) => void;
  /** called once, when it exits (stopped included) */
  onExit?: (job: Job) => void;
}

export interface Job {
  id: number;
  spec: JobSpec;
  phase: JobPhase;
  lines: OutputLine[];
  /** lines ever written, so a console can key rows absolutely */
  total: number;
  startedAt: number;
  endedAt: number | null;
  code: number | null;
  pid: number;
}

const MAX_LINES = 600;
const SECRET_RE = /(postgres(?:ql)?:\/\/[^:@/\s]+):[^@\s]+@/gi;

export function scrub(text: string): string {
  return text.replace(SECRET_RE, "$1:****@");
}

const alive = (j: Job) => j.phase === "starting" || j.phase === "ready" || j.phase === "running";

class JobManager {
  private jobs: Job[] = [];
  private handles = new Map<number, ProcHandle>();
  private listeners = new Set<() => void>();
  private nextId = 1;
  private pending = false;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Batched: a chatty dev server shouldn't re-render the panel per line. */
  private emit(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      for (const fn of this.listeners) fn();
    }, 120);
  }

  list(project: string): Job[] {
    const p = project.toLowerCase();
    return this.jobs.filter((j) => j.spec.project.toLowerCase() === p);
  }

  live(key: string): Job | null {
    return this.jobs.find((j) => j.spec.key === key && alive(j)) ?? null;
  }

  isAlive(job: Job): boolean {
    return alive(job);
  }

  start(spec: JobSpec): Job {
    const existing = this.live(spec.key);
    if (existing) return existing;
    const job: Job = {
      id: this.nextId++,
      spec,
      phase: spec.readyPort || spec.readyLine ? "starting" : "running",
      lines: [{ text: `$ ${spec.command}`, stream: "info" }],
      total: 1,
      startedAt: Date.now(),
      endedAt: null,
      code: null,
      pid: 0,
    };
    // Finished jobs of the same key make way, so the list stays one row per thing.
    this.jobs = this.jobs.filter((j) => j.spec.key !== spec.key || alive(j));
    this.jobs.push(job);
    const ready = () => {
      if (job.phase !== "starting") return;
      job.phase = "ready";
      spec.onReady?.(job);
      this.emit();
    };
    // A W: project runs inside WSL, where its node_modules were built.
    const wsl = inDistro(spec.cwd, spec.command, spec.env);
    const handle = runCommand(
      wsl?.argv ?? spec.command,
      wsl?.cwd ?? spec.cwd,
      (line) => {
        const text = scrub(line.text);
        job.lines.push({ ...line, text });
        job.total++;
        if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
        if (spec.readyLine?.test(text)) ready();
        this.emit();
      },
      wsl?.env ?? spec.env,
    );
    job.pid = handle.pid;
    this.handles.set(job.id, handle);
    if (spec.readyPort) {
      const port = spec.readyPort;
      const poll = async () => {
        while (job.phase === "starting") {
          if (await tcpOpen("127.0.0.1", port, 800)) return ready();
          await Bun.sleep(700);
        }
      };
      void poll();
    }
    void handle.exited.then((code) => {
      this.handles.delete(job.id);
      job.code = code;
      job.endedAt = Date.now();
      if (job.phase !== "stopped") job.phase = code === 0 ? "done" : "failed";
      job.lines.push({ text: job.phase === "stopped" ? "■ stopped" : `${code === 0 ? "✓" : "✗"} exited ${code}`, stream: "info" });
      job.total++;
      spec.onExit?.(job);
      this.emit();
    });
    this.emit();
    return job;
  }

  stop(job: Job): void {
    const h = this.handles.get(job.id);
    if (!h || !alive(job)) return;
    job.phase = "stopped";
    h.kill();
    this.emit();
  }

  /** Forget a finished job (the console's ✕). */
  dismiss(job: Job): void {
    if (alive(job)) return;
    this.jobs = this.jobs.filter((j) => j !== job);
    this.emit();
  }
}

export const jobs = new JobManager();
