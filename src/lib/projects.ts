import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, patchConfig } from "./config.ts";

export interface ProjectInfo {
  /** Absolute project directory */
  dir: string;
  /** Folder name (what you'd `cd` to) */
  name: string;
  /** package.json name when it differs from the folder name */
  pkgName: string | null;
  description: string;
  /** Detected stack label — see STACKS below */
  stack: string;
  isGit: boolean;
  branch: string | null;
  /** Newest of the folder / .git mtime — "last touched" */
  mtime: number;
  /** How many times it was opened FROM this picker */
  opens: number;
  lastOpened: number | null;
  /** Frecency: our own opens + whatever zoxide already knows about the folder */
  score: number;
}

export type SortMode = "frecency" | "modified" | "name";

const SKIP = new Set(["node_modules", "__pycache__", "$recycle.bin", "system volume information"]);

/** Where the projects live. Config wins over the platform default; env wins over both. */
export function projectsRoot(): string {
  const fromEnv = process.env.DESTEDTUI_PROJECTS_ROOT;
  if (fromEnv) return fromEnv;
  const fromConfig = readConfig().projectsRoot;
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;
  return process.platform === "win32" ? "G:\\code" : join(homedir(), "code");
}

/** Case- and separator-insensitive key for a path (Windows paths are both). */
function keyOf(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

interface OpenStat {
  n: number;
  at: number;
}

function loadOpens(): Record<string, OpenStat> {
  const raw = readConfig().projectOpens;
  return raw && typeof raw === "object" ? (raw as Record<string, OpenStat>) : {};
}

/** Remember that a project was opened — this is what makes the list self-sorting. */
export function recordProjectOpen(dir: string): void {
  const opens = loadOpens();
  const key = keyOf(dir);
  const prev = opens[key];
  opens[key] = { n: (prev?.n ?? 0) + 1, at: Date.now() };
  patchConfig({ projectOpens: opens });
}

/** zoxide's own frecency, folded from any sub-path up to its top-level project. */
function zoxideScores(root: string): Map<string, number> {
  const scores = new Map<string, number>();
  const rootKey = keyOf(root);
  try {
    const res = Bun.spawnSync(["zoxide", "query", "--list", "--score"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (res.exitCode !== 0) return scores;
    for (const line of new TextDecoder().decode(res.stdout).split(/\r?\n/)) {
      const m = /^\s*(-?[\d.]+)\s+(\S.*?)\s*$/.exec(line);
      if (!m) continue;
      const score = Number.parseFloat(m[1]!);
      if (!Number.isFinite(score) || score <= 0) continue;
      const key = keyOf(m[2]!);
      if (!key.startsWith(`${rootKey}/`)) continue;
      const segment = key.slice(rootKey.length + 1).split("/")[0];
      if (!segment) continue;
      const projectKey = `${rootKey}/${segment}`;
      scores.set(projectKey, (scores.get(projectKey) ?? 0) + score);
    }
  } catch {
    // zoxide not installed — our own open counts carry the ranking
  }
  return scores;
}

/** zoxide's decay curve: today is worth 16x last month. */
function decay(ageMs: number): number {
  const hours = ageMs / 3_600_000;
  if (hours < 1) return 4;
  if (hours < 24) return 2;
  if (hours < 24 * 7) return 0.5;
  return 0.25;
}

/** Framework/language guess, first match wins. */
function detectStack(files: Set<string>, dir: string): { stack: string; pkgName: string | null; description: string } {
  let pkgName: string | null = null;
  let description = "";

  if (files.has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (typeof pkg?.name === "string") pkgName = pkg.name;
      if (typeof pkg?.description === "string") description = pkg.description;
      const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
      const has = (name: string) => Object.hasOwn(deps, name);
      const stack = has("next")
        ? "next"
        : has("expo")
          ? "expo"
          : has("react-native")
            ? "react native"
            : has("@remotion/cli") || has("remotion")
              ? "remotion"
              : has("electron")
                ? "electron"
                : has("astro")
                  ? "astro"
                  : has("nuxt")
                    ? "nuxt"
                    : has("@sveltejs/kit") || has("svelte")
                      ? "svelte"
                      : has("@nestjs/core")
                        ? "nest"
                        : has("@opentui/core")
                          ? "opentui"
                          : has("vite")
                            ? "vite"
                            : has("react")
                              ? "react"
                              : files.has("bun.lock") || files.has("bun.lockb")
                                ? "bun"
                                : "node";
      return { stack, pkgName, description };
    } catch {
      return { stack: "node", pkgName, description };
    }
  }

  if (files.has("cargo.toml")) return { stack: "rust", pkgName, description };
  if (files.has("go.mod")) return { stack: "go", pkgName, description };
  if (files.has("pyproject.toml") || files.has("requirements.txt") || files.has("setup.py"))
    return { stack: "python", pkgName, description };
  if (files.has("pubspec.yaml")) return { stack: "flutter", pkgName, description };
  if (files.has("gemfile")) return { stack: "ruby", pkgName, description };
  if (files.has("composer.json")) return { stack: "php", pkgName, description };
  if (files.has("pom.xml") || files.has("build.gradle")) return { stack: "java", pkgName, description };
  if (files.has("index.html")) return { stack: "web", pkgName, description };
  for (const f of files) if (f.endsWith(".sln") || f.endsWith(".csproj")) return { stack: "dotnet", pkgName, description };

  return { stack: "", pkgName, description };
}

function readBranch(dir: string): string | null {
  try {
    // Strip non-printables first: a HEAD left as NUL padding by a bad shutdown
    // is otherwise "truthy" and paints invisible junk into the list row.
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8")
      .replace(/[^\x20-\x7e]/g, "")
      .trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1]!.trim() || null;
    return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : null; // detached HEAD
  } catch {
    return null;
  }
}

/**
 * One shallow pass over the projects root. Deliberately sync and cheap
 * (one readdir + a couple of stats per project) so the picker paints instantly.
 */
export function scanProjects(root: string): ProjectInfo[] {
  const opens = loadOpens();
  const zoxide = zoxideScores(root);
  const now = Date.now();

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || SKIP.has(name.toLowerCase())) continue;
    const dir = join(root, name);

    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let files: Set<string>;
    try {
      files = new Set(readdirSync(dir).map((f) => f.toLowerCase()));
    } catch {
      files = new Set();
    }

    const isGit = files.has(".git");
    let mtime = st.mtimeMs;
    if (isGit) {
      try {
        // The reflog is appended on every commit/checkout/pull, so it catches
        // work that never touched a top-level file. Deliberately NOT the .git
        // folder or its index: both get bumped by any passing `git status`
        // (measured: all 221 repos looked "just now"), which is useless here.
        mtime = Math.max(mtime, statSync(join(dir, ".git", "logs", "HEAD")).mtimeMs);
      } catch {
        /* no reflog yet, worktree, or permission — folder mtime is fine */
      }
    }

    const { stack, pkgName, description } = detectStack(files, dir);
    const stat = opens[keyOf(dir)];
    const own = stat ? stat.n * decay(now - stat.at) : 0;

    projects.push({
      dir,
      name,
      pkgName: pkgName && pkgName !== name ? pkgName : null,
      description,
      stack,
      isGit,
      branch: isGit ? readBranch(dir) : null,
      mtime,
      opens: stat?.n ?? 0,
      lastOpened: stat?.at ?? null,
      score: own + (zoxide.get(keyOf(dir)) ?? 0),
    });
  }

  return projects;
}

export function sortProjects(projects: ProjectInfo[], mode: SortMode): ProjectInfo[] {
  const sorted = [...projects];
  if (mode === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === "modified") sorted.sort((a, b) => b.mtime - a.mtime);
  else sorted.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return sorted;
}

/** "3d" / "2h" / "just now" — compact enough for a list row. */
export function fmtAgo(at: number | null): string {
  if (!at) return "never";
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  const w = d / 7;
  if (w < 5) return `${Math.round(w)}w ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export interface ParsedQuery {
  /** The part we're deliberately not matching on — rendered dim. */
  ignored: string;
  /** Everything after it, exactly as typed. */
  rest: string;
  /** What actually gets matched. */
  query: string;
}

/** Navigation verbs that muscle memory types before a project name. */
const NAV_PREFIX = /^(cd|cod|z|zi|ls|dir|pushd)\s+/i;

/**
 * The picker opens where a prompt used to be, so half the time you type
 * `cd drydock` — or paste `g:\code\drydock\src`. Strip the parts that aren't a
 * project name and match on what's left, showing the ignored bit dimmed so it
 * never looks like the filter is broken.
 */
export function parseQuery(raw: string, root: string): ParsedQuery {
  let rest = raw;
  let ignored = "";
  const take = (n: number) => {
    ignored += rest.slice(0, n);
    rest = rest.slice(n);
  };

  const lead = /^\s+/.exec(rest);
  if (lead) take(lead[0].length);

  const cmd = NAV_PREFIX.exec(rest);
  if (cmd) take(cmd[0].length);

  const dot = /^\.[\\/]/.exec(rest);
  if (dot) take(2);

  // An absolute path into the root: keep only what follows it.
  const rootKey = root.replace(/[\\/]+$/, "");
  const norm = (s: string) => s.replace(/[\\/]+/g, "/").toLowerCase();
  const normRest = norm(rest);
  const normRoot = norm(rootKey);
  if (normRest.startsWith(`${normRoot}/`)) take(rootKey.length + 1);
  else if (normRest === normRoot) take(rest.length);

  // We can only jump to a project, so a deeper path matches its first segment.
  const query = rest.replace(/[\\/]+$/, "").split(/[\\/]/)[0] ?? "";
  return { ignored, rest, query };
}

export interface ProjectDetail {
  dir: string;
  branch: string | null;
  ahead: number;
  behind: number;
  upstream: string | null;
  dirty: number;
  lastCommit: { hash: string; when: string; subject: string } | null;
  error: string | null;
}

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    // A repo on a cold/huge tree can take a while; the pane is optional, so bail.
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, 4000);
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? text : null;
  } catch {
    return null;
  }
}

/** Live git state for the highlighted project — one repo at a time, never the whole list. */
export async function inspectProject(dir: string): Promise<ProjectDetail> {
  const detail: ProjectDetail = {
    dir,
    branch: null,
    ahead: 0,
    behind: 0,
    upstream: null,
    dirty: 0,
    lastCommit: null,
    error: null,
  };

  const status = await git(dir, ["status", "--porcelain=v1", "-b"]);
  if (status === null) {
    // A .git that git itself rejects is damage, not a plain folder — say which.
    detail.error = existsSync(join(dir, ".git")) ? ".git is there but unreadable" : "not a git repository";
    return detail;
  }

  const lines = status.split(/\r?\n/).filter((l) => l.length > 0);
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      const [names, tracking] = head.split(/\s+(?=\[)/);
      const [branch, upstream] = (names ?? "").split("...");
      detail.branch = branch?.replace(/^No commits yet on /, "") ?? null;
      detail.upstream = upstream ?? null;
      const ahead = /ahead (\d+)/.exec(tracking ?? "");
      const behind = /behind (\d+)/.exec(tracking ?? "");
      detail.ahead = ahead ? Number(ahead[1]) : 0;
      detail.behind = behind ? Number(behind[1]) : 0;
    } else {
      detail.dirty++;
    }
  }

  const log = await git(dir, ["log", "-1", "--format=%h%x1f%cr%x1f%s"]);
  if (log) {
    const [hash, when, subject] = log.trim().split("\u001f");
    if (hash) detail.lastCommit = { hash, when: when ?? "", subject: subject ?? "" };
  }

  return detail;
}
