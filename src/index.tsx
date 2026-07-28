#!/usr/bin/env bun
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";
import type { Route } from "./routes.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`destedtui — personal dev-project TUI

Usage:
  destedtui             open the utility menu for the current directory
  destedtui --projects  pick a project and cd there  (alias: -p, --cd)
  destedtui --backup    jump straight to Postgres backup
  destedtui --restore   jump straight to Postgres restore
  destedtui --local     browse localhost Postgres databases
  destedtui --pull      clone a .env database into localhost

  destedtui --install-shell   add \`proj\` + auto-launch to your PowerShell profile

Utilities:
  Projects        every folder in g:\\code, ranked by how often you open it
  Scripts         find every package.json script in the tree and run it
  PG Backup       dump the DATABASE_URL database (any pg 9.4+) to a zip
  PG Restore      restore a zip/dump/.sql — original server or localhost
  Local Postgres  browse localhost DBs: create, drop, back up, restore into
  Pull to Local   dump a remote/.env DB and restore it into localhost, one shot

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

let initialRoute: Route = { name: "menu" };
if (args.includes("--projects") || args.includes("--cd") || args.includes("-p")) initialRoute = { name: "projects" };
else if (args.includes("--restore")) initialRoute = { name: "restore" };
else if (args.includes("--backup")) initialRoute = { name: "backup" };
else if (args.includes("--local")) initialRoute = { name: "localdb" };
else if (args.includes("--pull")) initialRoute = { name: "pull" };

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30,
});

createRoot(renderer).render(<App initialRoute={initialRoute} cwd={process.cwd()} />);
