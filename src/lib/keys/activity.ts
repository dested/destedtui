// Is a project alive? Last time Sal typed a prompt in it (~/.claude/history.jsonl,
// the same source sal-agent's projectIndex reads) or committed to it (git log).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { projectsRoot } from "../projects.ts";

export const ACTIVE_DAYS = 30;
const DAY = 86_400_000;

export interface Activity {
  /** ms epoch of the latest prompt or commit, null when neither exists. */
  lastAt: number | null;
  source: "claude" | "git" | null;
  active: boolean;
}

let promptCache: { at: number; map: Map<string, number> } | null = null;

/** Folder (lowercased) → last prompt time, from Claude's prompt history. Memoized for a minute. */
function lastPrompts(): Map<string, number> {
  if (promptCache && Date.now() - promptCache.at < 60_000) return promptCache.map;
  const map = new Map<string, number>();
  const file = join(homedir(), ".claude", "history.jsonl");
  const root = projectsRoot();
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const ts = /"timestamp":(\d+)/.exec(line);
      const proj = /"project":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (!ts?.[1] || !proj?.[1]) continue;
      let cwd: string;
      try {
        cwd = JSON.parse(`"${proj[1]}"`);
      } catch {
        continue;
      }
      const rel = relative(root, cwd);
      if (!rel || rel.startsWith("..") || /^[a-zA-Z]:/.test(rel)) continue;
      const folder = rel.split(sep)[0]?.toLowerCase();
      if (!folder) continue;
      const at = Number(ts[1]);
      if (at > (map.get(folder) ?? 0)) map.set(folder, at);
    }
  }
  promptCache = { at: Date.now(), map };
  return map;
}

/**
 * Last commit time. The reflog (.git/logs/HEAD) is a file read; its "commit"
 * entries carry the timestamp, so no git process is needed for the common case.
 */
function lastCommit(dir: string): number | null {
  if (!existsSync(join(dir, ".git"))) return null;
  const log = join(dir, ".git", "logs", "HEAD");
  if (existsSync(log)) {
    const lines = readFileSync(log, "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /> (\d{9,}) [+-]\d{4}\tcommit/.exec(lines[i] ?? "");
      if (m?.[1]) return Number(m[1]) * 1000;
    }
  }
  const r = Bun.spawnSync(["git", "-C", dir, "log", "-1", "--format=%ct"], { stdout: "pipe", stderr: "ignore" });
  const s = Number.parseInt(r.stdout.toString().trim(), 10);
  return Number.isFinite(s) ? s * 1000 : null;
}

export function activityOf(project: string, now = Date.now()): Activity {
  const prompt = lastPrompts().get(project.toLowerCase()) ?? null;
  const commit = lastCommit(join(projectsRoot(), project));
  const lastAt = Math.max(prompt ?? 0, commit ?? 0) || null;
  const source = lastAt === null ? null : prompt !== null && prompt >= (commit ?? 0) ? "claude" : "git";
  return { lastAt, source, active: lastAt !== null && now - lastAt < ACTIVE_DAYS * DAY };
}
