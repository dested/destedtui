// The static half of the project panel: what's on disk. Packages and .env
// databases come from discovery (lib/discovery.ts); this adds prisma schemas,
// every .env file's variable NAMES (values never leave the file), the dev
// commands worth offering, and recent git history.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isEnvFile, parseEnv, SKIP_DIRS, type Discovery, type PackageInfo } from "../discovery.ts";
import { gitCommand } from "../keys/envfile.ts";
import { devTarget, type DevTarget } from "./devport.ts";
import { findSchemas, type PrismaSchema } from "./prisma.ts";

export interface EnvFile {
  path: string;
  /** relative to the project, forward slashes */
  rel: string;
  names: string[];
}

export interface DevCommand {
  label: string;
  command: string;
  cwd: string;
  /** where it'll serve, null when nothing on disk says */
  target: DevTarget | null;
}

export interface Commit {
  hash: string;
  when: string;
  subject: string;
}

export interface StaticPicture {
  schemas: PrismaSchema[];
  envFiles: EnvFile[];
  dev: DevCommand[];
}

/** .env* files three levels down, names only. */
export function envFiles(dir: string, maxDepth = 3): EnvFile[] {
  const out: EnvFile[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
      } else if (isEnvFile(e.name)) {
        try {
          out.push({ path: full, rel: relative(dir, full).replace(/\\/g, "/"), names: Object.keys(parseEnv(readFileSync(full, "utf8"))).sort() });
        } catch {
          /* unreadable */
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));
}

const DEV_SCRIPTS = ["dev", "start", "serve"];

/** The root's dev script, then each workspace package's (a monorepo's apps). */
export function devCommands(packages: PackageInfo[], projectDir: string): DevCommand[] {
  const out: DevCommand[] = [];
  for (const p of packages) {
    const script = DEV_SCRIPTS.find((s) => typeof p.scripts[s] === "string");
    // a dependency cache vendored into the repo (video-studio's data/bun-cache) isn't an app
    if (!script || /(?:^|[\\/])(?:bun-cache|\.cache|node_modules)(?:[\\/]|$)/.test(p.rel)) continue;
    out.push({
      label: p.rel === "." ? `${p.pm} run ${script}` : `${p.rel.replace(/\\/g, "/")} · ${script}`,
      command: `${p.pm} run ${script}`,
      cwd: p.dir,
      target: devTarget(p.scripts[script] ?? "", p.dir, projectDir),
    });
  }
  return out;
}

export function staticPicture(dir: string, discovery: Discovery): StaticPicture {
  return { schemas: findSchemas(dir, discovery.packages), envFiles: envFiles(dir), dev: devCommands(discovery.packages, dir) };
}

/** The last few commits, newest first (empty when it isn't a repo). */
export async function recentCommits(dir: string, n = 5): Promise<Commit[]> {
  try {
    const { cmd, cwd } = gitCommand(dir, ["log", `-${n}`, "--format=%h%x1f%cr%x1f%s"]);
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return [];
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [hash = "", when = "", subject = ""] = l.split("\u001f");
        return { hash, when, subject };
      });
  } catch {
    return [];
  }
}
