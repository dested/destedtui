// Writing keys into a project's .env without disturbing anything else in it:
// every other line, comment, blank line and line ending survives; only the
// assignment lines for the vars we own are replaced, added or removed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export type Change = "add" | "update" | "same" | "remove";

export interface EnvPlan {
  file: string;
  changes: { envVar: string; change: Change }[];
}

function assignmentRe(envVar: string): RegExp {
  return new RegExp(`^\\s*(export\\s+)?${envVar}\\s*=`);
}

function quote(value: string): string {
  return /[\s#"'`$\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function readLines(file: string): { lines: string[]; eol: string } {
  if (!existsSync(file)) return { lines: [], eol: "\n" };
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { lines, eol };
}

function writeLines(file: string, lines: string[], eol: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.length ? lines.join(eol) + eol : "");
}

/** Value currently assigned to a var in the file (last assignment wins, like dotenv). */
function currentValue(lines: string[], envVar: string): string | undefined {
  const re = assignmentRe(envVar);
  let found: string | undefined;
  for (const line of lines) {
    if (!re.test(line)) continue;
    let v = line.slice(line.indexOf("=") + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    found = v;
  }
  return found;
}

/**
 * Set each var to its value. Existing assignments are rewritten in place (all of
 * them, so a duplicate can't shadow the new value); missing ones are appended.
 */
export function upsertEnv(file: string, vars: Record<string, string>, dryRun: boolean): EnvPlan {
  const { lines, eol } = readLines(file);
  const plan: EnvPlan = { file, changes: [] };
  const out = [...lines];
  for (const [envVar, value] of Object.entries(vars)) {
    const re = assignmentRe(envVar);
    const before = currentValue(out, envVar);
    if (before === value) {
      plan.changes.push({ envVar, change: "same" });
      continue;
    }
    let replaced = false;
    for (let i = 0; i < out.length; i++) {
      const line = out[i];
      if (line === undefined || !re.test(line)) continue;
      const exported = /^\s*export\s+/.test(line) ? "export " : "";
      out[i] = `${exported}${envVar}=${quote(value)}`;
      replaced = true;
    }
    if (!replaced) out.push(`${envVar}=${quote(value)}`);
    plan.changes.push({ envVar, change: replaced ? "update" : "add" });
  }
  if (!dryRun && plan.changes.some((c) => c.change !== "same")) writeLines(file, out, eol);
  return plan;
}

/** Remove a var's assignment lines — only when the value there is the one we're revoking. */
export function removeFromEnv(file: string, envVar: string, onlyIfValue: string): boolean {
  const { lines, eol } = readLines(file);
  const re = assignmentRe(envVar);
  if (currentValue(lines, envVar) !== onlyIfValue) return false;
  const kept = lines.filter((l) => !re.test(l));
  writeLines(file, kept, eol);
  return true;
}

function git(cwd: string, args: string[]): number {
  try {
    return Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode ?? 1;
  } catch {
    return 1;
  }
}

export interface IgnoreResult {
  /** True when we appended a line to .gitignore. */
  added: boolean;
  /** The file is committed — .gitignore can't help; the key is in git history. */
  tracked: boolean;
}

/**
 * Make sure the env file is gitignored. In a git repo `git check-ignore` is the
 * truth (it understands every nested .gitignore and global excludes); outside
 * one we just make sure the project's .gitignore names it.
 */
export function ensureIgnored(projectDir: string, envFile: string): IgnoreResult {
  const abs = join(projectDir, envFile);
  const rel = relative(projectDir, abs).replace(/\\/g, "/");
  const isRepo = existsSync(join(projectDir, ".git"));
  const tracked = isRepo && git(projectDir, ["ls-files", "--error-unmatch", rel]) === 0;
  if (isRepo && git(projectDir, ["check-ignore", "-q", rel]) === 0) return { added: false, tracked };
  const gi = join(projectDir, ".gitignore");
  const { lines, eol } = readLines(gi);
  const entry = rel === ".env" ? ".env" : rel;
  if (!lines.some((l) => l.trim() === entry || l.trim() === `/${entry}`)) {
    writeLines(gi, [...lines, entry], eol);
    return { added: true, tracked };
  }
  return { added: false, tracked };
}
