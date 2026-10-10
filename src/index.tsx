#!/usr/bin/env bun
import { join } from "node:path";
import type { Route } from "./routes.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`destedtui — personal dev-project TUI

Usage:
  destedtui             open the utility menu for the current directory
  destedtui --projects  pick a project and cd there  (alias: -p, --cd)
  destedtui --startup   boot all your dev servers in a live console dashboard
  destedtui --term      terminal multiplexer: shells & claude sessions in panes
  destedtui --ports     every node/bun localhost server — open, cd, kill
                        (--json prints one scan with page titles, --all every listener)
  destedtui --procs     what every claude session spun up (servers, watchers, orphans) — cpu, kill
  destedtui --bx        every bx browser daemon: what it's doing, who drives it, memory growth, orphans
                        (--log appends every scan to ~/.destedtui/bx-memlog/<date>.jsonl)
  destedtui --keys      the API-key vault (also its own bin: keys --help)
  destedtui --backup    jump straight to Postgres backup
  destedtui --restore   jump straight to Postgres restore
  destedtui --local     browse localhost Postgres databases
  destedtui --pull      clone a .env database into localhost
  destedtui --review    clean-context claude review of this repo
  destedtui --claude    claude code usage: cost, tokens, sessions, timeline per project
  destedtui --usage     the same, printed (--days 1|7|30|90|all, --project <name>, --json)

  destedtui --install-shell   add \`proj\` + auto-launch to your PowerShell profile

Utilities:
  Projects        every folder in g:\\code, ranked by how often you open it
  Scripts         find every package.json script in the tree and run it
  PG Backup       dump the DATABASE_URL database (any pg 9.4+) to a zip
  PG Restore      restore a zip/dump/.sql — original server or localhost
  Local Postgres  browse localhost DBs: create, drop, back up, restore into
  Pull to Local   dump a remote/.env DB and restore it into localhost, one shot
  Review          clean-context claude code review — changes, commits, branch, or a PR

Postgres client tools are auto-downloaded per server version and cached
in ~/.destedtui/pg. Nothing to install.`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log("destedtui 0.1.0");
  process.exit(0);
}

if (args.includes("--install-shell")) {
  // The installer is PowerShell because it has to reason about $PROFILE,
  // symlinks and shims — all things PowerShell already knows.
  const script = join(import.meta.dir, "..", "shell", "install.ps1");
  const proc = Bun.spawnSync(["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(proc.exitCode ?? 0);
}

if (args.includes("--ports") && args.includes("--json")) {
  const { runPortsJson } = await import("./lib/ports-json.ts");
  process.exit(await runPortsJson(args));
}

if (args.includes("--usage")) {
  const { runUsageCli } = await import("./lib/claude/cli.ts");
  process.exit(runUsageCli(args));
}

let initialRoute: Route = { name: "menu" };
if (args.includes("--projects") || args.includes("--cd") || args.includes("-p")) initialRoute = { name: "projects" };
else if (args.includes("--startup")) initialRoute = { name: "startup" };
else if (args.includes("--term")) initialRoute = { name: "term" };
else if (args.includes("--ports")) initialRoute = { name: "ports" };
else if (args.includes("--procs")) initialRoute = { name: "procs" };
else if (args.includes("--bx")) initialRoute = { name: "bx", log: args.includes("--log") };
else if (args.includes("--keys")) initialRoute = { name: "keys" };
else if (args.includes("--restore")) initialRoute = { name: "restore" };
else if (args.includes("--backup")) initialRoute = { name: "backup" };
else if (args.includes("--local")) initialRoute = { name: "localdb" };
else if (args.includes("--pull")) initialRoute = { name: "pull" };
else if (args.includes("--review")) initialRoute = { name: "review" };
else if (args.includes("--claude")) initialRoute = { name: "claude" };

const { bootTui } = await import("./tui.tsx");
await bootTui(initialRoute);
