// Which project a directory belongs to: the first folder under a projects root
// (W:\code\nbajam\apps\web → W:\code\nbajam), else the git toplevel, else the
// directory itself. Everything on the project panel hangs off this.

import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectRoots } from "../projects.ts";
import { normalizeWslUnc } from "../platform.ts";

export interface ProjectRef {
  /** folder name */
  name: string;
  /** absolute project directory */
  dir: string;
  /** the projects root it sits in, or null when it's outside every root */
  root: string | null;
}

/** The project `cwd` is in, or null when cwd IS a projects root (nothing to show there). */
export function projectAt(cwd: string, roots = projectRoots()): ProjectRef | null {
  const here = resolve(normalizeWslUnc(cwd));
  for (const root of roots) {
    const rel = relative(root, here);
    if (rel === "") return null;
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const top = rel.split(sep)[0];
    if (top) return { name: top, dir: join(root, top), root };
  }
  let d = here;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".git"))) return { name: basename(d), dir: d, root: null };
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return { name: basename(here) || here, dir: here, root: null };
}

/** Case- and separator-insensitive "is `path` inside `dir`" (Windows paths are both). */
export function inside(path: string, dir: string): boolean {
  if (!path) return false;
  const k = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = k(path);
  const d = k(dir);
  return p === d || p.startsWith(`${d}/`);
}
