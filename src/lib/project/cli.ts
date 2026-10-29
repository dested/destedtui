// `destedtui --project [name|path] --json`: the project panel's picture as
// JSON for agents ("is the server up, which port, which DB, what's pending").
// Exit 0 printed, 1 no such project.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { projectRoots } from "../projects.ts";
import { projectAt, type ProjectRef } from "./context.ts";
import { gather, toJson } from "./picture.ts";

/** The project named right after --project (a folder name or a path), else the cwd's. */
export function projectFromArgs(args: string[], cwd: string): ProjectRef | { error: string } {
  const at = args.indexOf("--project");
  const next = at >= 0 ? args[at + 1] : undefined;
  if (!next || next.startsWith("-")) return projectAt(cwd) ?? { error: `${cwd} is a projects root, not a project — cd into one or name it: --project <name>` };
  const asPath = isAbsolute(next) ? next : resolve(cwd, next);
  if (existsSync(asPath) && (next.includes("/") || next.includes("\\") || next === ".")) return projectAt(asPath) ?? { error: `${asPath} is a projects root` };
  for (const root of projectRoots()) {
    const dir = join(root, next);
    if (existsSync(dir)) return { name: next, dir, root };
  }
  return { error: `no project "${next}" in ${projectRoots().join(" or ")}` };
}

export async function runProjectJson(args: string[]): Promise<number> {
  const ref = projectFromArgs(args, process.cwd());
  if ("error" in ref) {
    console.error(ref.error);
    return 1;
  }
  const picture = await gather(ref, { probe: !args.includes("--no-db") });
  console.log(JSON.stringify(toJson(picture), null, 2));
  return 0;
}
