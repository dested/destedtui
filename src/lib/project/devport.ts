// Where a dev command will serve, before it runs: a portless name
// (https://<name>.localhost) or a port, and which file said so. First hit wins:
//   portless  — the script (or the script file it runs) calls portless; name
//               from `portless <name>`, portless.json or jig.json
//   flag      — `--port N` / `-p N` / `PORT=N` in the script
//   project.json — sal-starter forks' `apiPort`
//   .env      — PORT= in the package's .env.local/.env.development/.env, then the project's
//   source    — a `PORT ?? 4747` / `DEFAULT_PORT = 4747` in the script file it runs
//   expo      — Metro's own 8081
//   vite      — vite.config's `port:`, else vite's own 5173
// A guess, labelled as one: null when nothing says.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { parseEnv } from "../discovery.ts";

export interface DevTarget {
  port: number | null;
  /** where it'll answer: https://<name>.localhost for portless, else http://localhost:<port> */
  url: string | null;
  /** what said so: "portless.json", "--port", ".env", "project.json", "server.ts", "vite.config", "vite default" */
  via: string;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const nameSchema = z.object({ name: z.string().min(1) });
const jigSchema = z.object({ name: z.string().min(1).optional(), portless: z.boolean().optional() });
const projectJsonSchema = z.object({ apiPort: z.number().int(), metroPort: z.number().int().optional(), desktopPort: z.number().int().optional() });

function jsonFile<T>(path: string, schema: z.ZodType<T>): T | null {
  const text = read(path);
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const port = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

const at = (p: number, via: string): DevTarget => ({ port: p, url: `http://localhost:${p}`, via });

/** The .ts/.js file a script runs (`bun --watch server.ts`, `bun scripts/dev.ts`), as a path. */
function entryFile(script: string, cwd: string): string | null {
  const m = /(?:^|\s)((?:\.\/)?[\w./-]+\.(?:ts|tsx|js|mjs|cjs))(?:\s|$)/.exec(script);
  if (!m?.[1]) return null;
  const path = resolve(cwd, m[1]);
  return existsSync(path) ? path : null;
}

function portlessName(script: string, dirs: string[]): string | null {
  const named = /portless\s+(?!run\b|proxy\b)([a-z0-9][a-z0-9-]*)\s/.exec(script);
  if (named?.[1]) return named[1];
  for (const d of dirs) {
    const pl = jsonFile(join(d, "portless.json"), nameSchema);
    if (pl) return pl.name;
    const jig = jsonFile(join(d, "jig.json"), jigSchema);
    if (jig?.portless && jig.name) return jig.name;
  }
  return null;
}

function envPort(dirs: string[]): DevTarget | null {
  for (const d of dirs) {
    for (const f of [".env.local", ".env.development", ".env"]) {
      const text = read(join(d, f));
      const p = text === null ? null : port(parseEnv(text).PORT);
      if (p) return at(p, d === dirs[0] ? f : `../${f}`);
    }
  }
  return null;
}

/**
 * `pkgDir` runs `script`; `projectDir` is the repo root (a workspace app falls
 * back to the root's .env, portless.json, project.json). One `--cwd <dir>`
 * delegation (`bun run --cwd apps/web dev`) is followed.
 */
export function devTarget(script: string, pkgDir: string, projectDir: string, depth = 0): DevTarget | null {
  const delegated = /--cwd[ =](\S+)\s+(?:run\s+)?(\S+)/.exec(script);
  if (delegated?.[1] && delegated[2] && depth === 0) {
    const sub = resolve(pkgDir, delegated[1]);
    const pkg = jsonFile(join(sub, "package.json"), z.object({ scripts: z.record(z.string(), z.string()).optional() }));
    const inner = pkg?.scripts?.[delegated[2]];
    if (inner) return devTarget(inner, sub, projectDir, 1);
  }
  const dirs = pkgDir === projectDir ? [pkgDir] : [pkgDir, projectDir];
  const entry = entryFile(script, pkgDir);
  const entryText = entry ? read(entry) : null;

  if (/\bportless\b/.test(script) || /\bportless\b/.test(entryText ?? "")) {
    const name = portlessName(script, dirs);
    if (name) return { port: null, url: `https://${name}.localhost`, via: "portless" };
  }

  const flag = /(?:--port[ =]|(?:^|\s)-p\s+|(?:^|\s)PORT=)(\d{2,5})\b/.exec(script);
  const fp = port(flag?.[1]);
  if (fp) return at(fp, flag?.[0].includes("PORT=") ? "PORT=" : "--port");

  // sal-starter forks: one file names the api, Metro and desktop ports; the package says which it is.
  const leaf = relative(projectDir, pkgDir).replace(/\\/g, "/");
  const role = /(?:^|\/)(?:mobile|native)(?:\/|$)/i.test(leaf) ? "metroPort" : /(?:^|\/)desktop(?:\/|$)/i.test(leaf) ? "desktopPort" : "apiPort";
  for (const d of dirs) {
    const pj = jsonFile(join(d, "project.json"), projectJsonSchema);
    const pp = pj ? port(String(pj[role] ?? "")) : null;
    if (pp) return at(pp, `project.json ${role}`);
  }

  const env = envPort(dirs);
  if (env) return env;

  if (entryText && entry) {
    const m = /\bPORT\b[^\n]{0,40}?(?:\?\?|\|\|)\s*['"]?(\d{4,5})|DEFAULT_PORT\s*=\s*(\d{4,5})/.exec(entryText);
    const sp = port(m?.[1] ?? m?.[2]);
    if (sp) return at(sp, entry.replace(/\\/g, "/").split("/").pop() ?? "source");
  }

  if (/\bexpo\s+start\b/.test(script)) return at(8081, "metro default");

  if (/(?:^|\s|\/)vite(?:\s|$)/.test(script)) {
    for (const f of ["vite.config.ts", "vite.config.mts", "vite.config.js"]) {
      const m = /\bport:\s*(\d{2,5})/.exec(read(join(pkgDir, f)) ?? "");
      const vp = port(m?.[1]);
      if (vp) return at(vp, "vite.config");
    }
    return at(5173, "vite default");
  }
  return null;
}
