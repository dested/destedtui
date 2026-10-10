// @ts-check
// The launcher every global bin goes through (destedtui, keys, review).
//
// A long-lived TUI process leaks native memory we can't free from inside it
// (plans/2026-10-07-memory-leak.md): one terminal left open for a day reached
// 68 GB of commit. So the bins don't run the TUI themselves. This Node process
// (~15 MB; Bun's own baseline on Windows is ~340 MB, which is why this isn't
// Bun) runs `bun src/<entry>` as a child and passes its exit code through.
// After a minute idle the child writes a resume file and exits PAUSED_EXIT,
// handing every byte back to Windows; this shows bin/paused.mjs and, on a
// click, starts a fresh child on the same screens.
//
// The launcher never reads stdin: the child and the paused screen own the
// console in turn. Keep the constants in step with src/lib/pause.ts.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PAUSED_EXIT = 75;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    child.on("error", (err) => {
      console.error(`destedtui: couldn't start ${cmd}: ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** @param {string} entry  the bin's real entry, relative to the repo (src/index.tsx) */
export async function launch(entry) {
  // Ctrl+C belongs to the child (opentui reads it raw). A stray console
  // CTRL_C_EVENT must not take the launcher down and orphan the child.
  process.on("SIGINT", () => {});

  const args = process.argv.slice(2);
  // Only an interactive terminal pauses; piped/headless runs (keys list,
  // review --headless, --usage) just pass through.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const file = join(tmpdir(), `destedtui-resume-${process.pid}.json`);
  let resume = false;

  for (;;) {
    /** @type {NodeJS.ProcessEnv} */
    const env = interactive
      ? { ...process.env, DESTEDTUI_SUPERVISED: "1", DESTEDTUI_RESUME_FILE: file, DESTEDTUI_RESUME: resume ? "1" : "0" }
      : process.env;
    const code = await run("bun", [join(root, entry), ...args], env);
    if (!interactive || code !== PAUSED_EXIT) {
      rmSync(file, { force: true });
      process.exit(code);
    }
    const choice = await run(process.execPath, [join(root, "bin", "paused.mjs"), file], process.env);
    if (choice !== 0) {
      rmSync(file, { force: true });
      process.exit(0);
    }
    resume = true;
  }
}
