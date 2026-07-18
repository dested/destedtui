#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";
import type { Route } from "./routes.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`destedtui — personal dev-project TUI

Usage:
  destedtui             open the utility menu for the current directory
  destedtui --backup    jump straight to Postgres backup
  destedtui --restore   jump straight to Postgres restore

Utilities:
  Scripts     find every package.json script in the tree and run it
  PG Backup   dump the DATABASE_URL database (any pg 9.4+) to a zip
  PG Restore  restore a backup zip — into a new DB or over the original

Postgres client tools are auto-downloaded per server version and cached
in ~/.destedtui/pg. Nothing to install.`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log("destedtui 0.1.0");
  process.exit(0);
}

let initialRoute: Route = { name: "menu" };
if (args.includes("--restore")) initialRoute = { name: "restore" };
else if (args.includes("--backup")) initialRoute = { name: "backup" };

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30,
});

createRoot(renderer).render(<App initialRoute={initialRoute} cwd={process.cwd()} />);
