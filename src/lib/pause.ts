import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";

// The idle-pause contract between the TUI and bin/launch.mjs (the Node launcher
// every global bin goes through) and bin/paused.mjs (the paused screen). Those
// two are plain JS and read the file by hand: keep the fields below in step.

/** Child exit code meaning "I went idle and saved my place — show the paused screen". */
export const PAUSED_EXIT = 75;

/** Set on the TUI child by bin/launch.mjs: a launcher is waiting, so idling out pauses. */
export const SUPERVISED_ENV = "DESTEDTUI_SUPERVISED";
/** Where the child writes its resume state when it pauses. */
export const RESUME_FILE_ENV = "DESTEDTUI_RESUME_FILE";
/** "1" when this child is a resume: read the resume file instead of the CLI route. */
export const RESUME_ENV = "DESTEDTUI_RESUME";
/** Idle timeout override in ms (testing); 0 turns the pause off entirely. */
export const IDLE_MS_ENV = "DESTEDTUI_IDLE_MS";

const DEFAULT_IDLE_MS = 60_000;

export function idleMs(): number {
  const parsed = z.coerce.number().int().nonnegative().safeParse(process.env[IDLE_MS_ENV]);
  return process.env[IDLE_MS_ENV] !== undefined && parsed.success ? parsed.data : DEFAULT_IDLE_MS;
}

/**
 * The routes that survive a pause. Anything carrying live payload (a running
 * script, a review, a backup/restore preset, a rotate walk) is busy and never
 * pauses, so it never needs to round-trip through the file.
 */
const resumableRoute = z.discriminatedUnion("name", [
  z.object({ name: z.literal("menu") }),
  z.object({ name: z.literal("scripts") }),
  z.object({ name: z.literal("localdb") }),
  z.object({ name: z.literal("startup") }),
  z.object({ name: z.literal("term") }),
  z.object({ name: z.literal("ports") }),
  z.object({ name: z.literal("procs") }),
  z.object({ name: z.literal("bx"), log: z.boolean().optional() }),
  z.object({ name: z.literal("bxProfiles") }),
  z.object({ name: z.literal("keys") }),
  z.object({ name: z.literal("projects") }),
  z.object({ name: z.literal("claude") }),
]);
export type ResumableRoute = z.infer<typeof resumableRoute>;
export const RESUMABLE = new Set<string>(resumableRoute.options.map((o) => o.shape.name.value));

const resumeState = z.object({
  v: z.literal(1),
  stack: z.array(resumableRoute).min(1),
  /** the screen it was on, for the paused screen */
  label: z.string(),
  /** private commit of the child just before it exited — what the pause gave back */
  commit: z.number().nonnegative(),
  pausedAt: z.number(),
});
export type ResumeState = z.infer<typeof resumeState>;

export function writeResumeState(file: string, state: ResumeState): void {
  writeFileSync(file, JSON.stringify(state));
}

export function readResumeState(file: string): ResumeState | null {
  try {
    const parsed = resumeState.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function removeResumeState(file: string): void {
  rmSync(file, { force: true });
}

const LABELS: Record<ResumableRoute["name"], string> = {
  menu: "menu",
  scripts: "scripts",
  localdb: "local postgres",
  startup: "startup",
  term: "terminal",
  ports: "localhost",
  procs: "claude procs",
  bx: "bx daemons",
  bxProfiles: "bx profiles",
  keys: "keys",
  projects: "projects",
  claude: "claude usage",
};

export function screenLabel(route: ResumableRoute): string {
  return LABELS[route.name];
}
