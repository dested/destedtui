import type { Route } from "../routes.ts";
import { idleMs } from "./pause.ts";
import { runningCount } from "./run.ts";
import { term } from "./term.ts";

/**
 * Screens whose state can't survive a restart: a script's output, a review in
 * flight or its report, a backup/restore/pull mid-flow, a key rotation walk.
 * Being on one holds the TUI awake.
 */
function busyRoute(route: Route): boolean {
  switch (route.name) {
    case "process":
    case "review":
    case "backup":
    case "restore":
    case "pull":
      return true;
    case "keys":
      return route.rotate !== undefined;
    default:
      return false;
  }
}

/**
 * Live work a pause would kill: anything spawned through lib/run.ts (startup
 * dev servers, pg tools, the reviewer, scripts) or an open terminal pane.
 */
export function isBusy(top: Route): boolean {
  return busyRoute(top) || runningCount() > 0 || term.count() > 0;
}

/**
 * Call `onIdle` once nobody has touched the terminal (key, click, wheel, mouse
 * move, focus) for idleMs() while nothing is busy. Busy time doesn't count:
 * the minute starts when the work ends. Returns the stop function.
 */
export function watchIdle(busy: () => boolean, onIdle: () => void): () => void {
  const limit = idleMs();
  if (limit === 0) return () => {};
  let last = Date.now();
  const touch = () => {
    last = Date.now();
  };
  // opentui reads stdin through its own "data" listener; a second one only observes.
  process.stdin.on("data", touch);
  const timer = setInterval(
    () => {
      if (busy()) return touch();
      if (Date.now() - last < limit) return;
      stop();
      onIdle();
    },
    Math.min(2000, Math.max(250, limit / 10)),
  );
  const stop = () => {
    clearInterval(timer);
    process.stdin.off("data", touch);
  };
  return stop;
}
