import { z } from "zod";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function git(args: string[], cwd: string): Promise<RunResult> {
  return run(["git", ...args], cwd);
}

export async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function hasCommits(root: string): Promise<boolean> {
  const result = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root);
  return result.code === 0;
}

export async function statusPorcelain(root: string): Promise<string> {
  return gitOrThrow(["status", "--porcelain=v1"], root);
}

function countLines(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

export async function uncommittedCount(root: string): Promise<number> {
  return countLines(await statusPorcelain(root));
}

export async function stagedCount(root: string): Promise<number> {
  return countLines(await gitOrThrow(["diff", "--cached", "--name-only"], root));
}

export async function currentBranch(root: string): Promise<string> {
  return gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], root);
}

/** Best-effort main branch: origin/HEAD, then local main/master. */
export async function mainBranch(root: string): Promise<string | null> {
  const originHead = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (originHead.code === 0) return originHead.stdout.trim();
  for (const candidate of ["main", "master"]) {
    const result = await git(["rev-parse", "--verify", "--quiet", candidate], root);
    if (result.code === 0) return candidate;
  }
  return null;
}

export async function branchAheadCount(root: string, base: string): Promise<number> {
  const count = await gitOrThrow(["rev-list", "--count", `${base}..HEAD`], root);
  const parsed = Number.parseInt(count, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  title: string;
  age: string;
  author: string;
}

export async function recentCommits(root: string, n: number): Promise<CommitInfo[]> {
  // Literal control bytes in source break this repo's tooling — build the 0x1f separator.
  const US = String.fromCharCode(0x1f);
  const format = ["%H", "%h", "%s", "%cr", "%an"].join("%x1f");
  const out = await gitOrThrow(["log", "-n", String(n), `--format=${format}`], root);
  if (out.length === 0) return [];
  const commits: CommitInfo[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split(US);
    const [sha, shortSha, title, age, author] = parts;
    if (sha === undefined || shortSha === undefined || title === undefined || age === undefined || author === undefined) {
      continue;
    }
    commits.push({ sha, shortSha, title, age, author });
  }
  return commits;
}

export async function stageAll(root: string): Promise<void> {
  await gitOrThrow(["add", "-A"], root);
}

export async function hasStagedChanges(root: string): Promise<boolean> {
  const result = await git(["diff", "--cached", "--quiet"], root);
  return result.code !== 0;
}

export async function commit(root: string, title: string, body: string): Promise<string> {
  const args = body.trim().length > 0 ? ["commit", "-m", title, "-m", body] : ["commit", "-m", title];
  await gitOrThrow(args, root);
  return gitOrThrow(["rev-parse", "--short", "HEAD"], root);
}

export interface PrInfo {
  number: number;
  title: string;
  author: string;
  branch: string;
}

const prListSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    headRefName: z.string(),
    author: z.object({ login: z.string() }).nullable().optional(),
  }),
);

/** Open PRs via gh, or null when gh is missing, unauthed, or speaks nonsense. */
export async function openPrs(root: string): Promise<PrInfo[] | null> {
  let result: RunResult;
  try {
    result = await run(["gh", "pr", "list", "--json", "number,title,headRefName,author", "--limit", "20"], root);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const prs = prListSchema.safeParse(parsed);
  if (!prs.success) return null;
  return prs.data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? "",
    branch: pr.headRefName,
  }));
}

const prViewSchema = z.object({ title: z.string() });

export async function prTitle(root: string, n: number): Promise<string | null> {
  let result: RunResult;
  try {
    result = await run(["gh", "pr", "view", String(n), "--json", "title"], root);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const view = prViewSchema.safeParse(parsed);
  return view.success ? view.data.title : null;
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The commit's parent, or the empty tree for a root commit. */
export async function parentOr(root: string, sha: string): Promise<string> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${sha}^`], root);
  return result.code === 0 ? `${sha}^` : EMPTY_TREE;
}
