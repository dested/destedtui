import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";
import type { Route } from "./routes.ts";
import { readResumeState, RESUME_ENV, RESUME_FILE_ENV, SUPERVISED_ENV } from "./lib/pause.ts";

/**
 * Boot the TUI. Under bin/launch.mjs (the global bins) a launcher is waiting
 * on us: idling out writes the resume file and exits PAUSED_EXIT, and a resume
 * starts on the saved screens instead of the CLI route.
 */
export async function bootTui(initialRoute: Route): Promise<void> {
  const file = process.env[SUPERVISED_ENV] === "1" ? process.env[RESUME_FILE_ENV] : undefined;
  const resumed = file && process.env[RESUME_ENV] === "1" ? readResumeState(file) : null;

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  });

  createRoot(renderer).render(
    <App initialRoute={initialRoute} initialStack={resumed?.stack} pauseFile={file || undefined} cwd={process.cwd()} />,
  );
}
