#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";
import type { Route } from "./routes.ts";
import { DEFAULT_EFFORT, DEFAULT_MODEL, resolveScopeFlags, type ReviewScope } from "./lib/review.ts";
import { runHeadless } from "./lib/reviewHeadless.ts";
import { hasCommits, repoRoot } from "./lib/reviewGit.ts";

const HELP = `review — clean-context claude code review, inside destedtui

usage:
  review                 pick a scope (staged, commits, branch, PR...) in the TUI
  review --staged        review staged changes only
  review --last-commit   review the HEAD commit
  review --last <n>      review the last n commits
  review --branch        review the whole branch vs main/master
  review --pr <n>        review an open GitHub PR (needs gh)

  --headless             no TUI — print the report to stdout (for scripts/skills)
  --dry-run              print the assembled reviewer prompt and exit (headless)
  --model <m>            reviewer model (headless; default claude-opus-4-8)
  --effort <e>           reviewer effort (headless; default high)

exit codes (headless): 0 pass · 1 blocked · 2 error`;

function die(message: string): never {
  console.error(message);
  process.exit(2);
}

/** The value after a flag, or a hard exit when it's missing/not an integer. */
function intArg(flag: string, raw: string | undefined): number {
  if (raw === undefined) die(`review: ${flag} needs a number`);
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) die(`review: ${flag} needs a positive number, got "${raw}"`);
  return n;
}

function strArg(flag: string, raw: string | undefined): string {
  if (raw === undefined) die(`review: ${flag} needs a value`);
  return raw;
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

let headless = false;
let dryRun = false;
let model = DEFAULT_MODEL;
let effort = DEFAULT_EFFORT;
const scopeFlags: { staged?: boolean; lastCommit?: boolean; last?: number; branch?: boolean; pr?: number } = {};
let scoped = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined) continue;
  if (arg === "--headless") headless = true;
  else if (arg === "--dry-run") {
    dryRun = true;
    headless = true;
  } else if (arg === "--staged") {
    scopeFlags.staged = true;
    scoped = true;
  } else if (arg === "--last-commit") {
    scopeFlags.lastCommit = true;
    scoped = true;
  } else if (arg === "--last") {
    scopeFlags.last = intArg("--last", args[++i]);
    scoped = true;
  } else if (arg === "--branch") {
    scopeFlags.branch = true;
    scoped = true;
  } else if (arg === "--pr") {
    scopeFlags.pr = intArg("--pr", args[++i]);
    scoped = true;
  } else if (arg === "--model") model = strArg("--model", args[++i]);
  else if (arg === "--effort") effort = strArg("--effort", args[++i]);
  else if (arg === "commit") {
    die("commit moved into the TUI — run `review` and press c after a passing review");
  } else die(`review: unknown argument "${arg}" — try review --help`);
}

const found = await repoRoot(process.cwd());
if (found === null) die("review: not inside a git repository");
// Re-bind so the narrowing survives into the closures below.
const root: string = found;
if (!(await hasCommits(root))) die("review: repository has no commits yet — make an initial commit first");

async function resolve(): Promise<ReviewScope> {
  try {
    return await resolveScopeFlags(root, scopeFlags);
  } catch (err) {
    die(`review: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (headless) {
  process.exit(await runHeadless(root, { scope: await resolve(), model, effort, dryRun }));
}

const initialRoute: Route = scoped
  ? { name: "review", scope: await resolve(), autoStart: true }
  : { name: "review" };

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30,
});

createRoot(renderer).render(<App initialRoute={initialRoute} cwd={process.cwd()} />);
