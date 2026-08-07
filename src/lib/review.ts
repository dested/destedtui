import { join } from "node:path";
import { z } from "zod";
import { trackProcess, treeKill } from "./run.ts";
import { currentBranch, mainBranch, parentOr, prTitle, recentCommits } from "./reviewGit.ts";

export const severitySchema = z.enum(["blocker", "warn", "nit"]);
export type Severity = z.infer<typeof severitySchema>;

export const findingSchema = z.object({
  severity: severitySchema,
  file: z.string(),
  line: z.number().int().positive().nullable(),
  title: z.string(),
  detail: z.string(),
  fix: z.string().nullable(),
});
export type Finding = z.infer<typeof findingSchema>;

export const commitMessageSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
});

export const reviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
  // Merge/deploy notes: migration ordering, seeds, env vars, PR hygiene — not code defects.
  notes: z.array(z.string()).default([]),
  commitMessage: commitMessageSchema,
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export type Verdict = "pass" | "blocked";

export type ReviewScope =
  | { kind: "uncommitted" }
  | { kind: "staged" }
  | { kind: "lastCommit" }
  | { kind: "commits"; fromSha: string; baseSha: string; count: number; fromTitle: string }
  | { kind: "branch"; base: string }
  | { kind: "pr"; number: number; title: string };

export const DEFAULT_MODEL = "claude-opus-4-8";
export const DEFAULT_EFFORT = "high";

export function scopeLabel(scope: ReviewScope): string {
  switch (scope.kind) {
    case "uncommitted":
      return "uncommitted changes";
    case "staged":
      return "staged changes";
    case "lastCommit":
      return "last commit";
    case "commits":
      return `last ${scope.count} commits`;
    case "branch":
      return `branch vs ${scope.base}`;
    case "pr":
      return `PR #${scope.number}`;
  }
}

export function computeVerdict(result: ReviewResult): Verdict {
  return result.findings.some((f) => f.severity === "blocker") ? "blocked" : "pass";
}

function scopeBlocks(scope: ReviewScope): { scopeText: string; diffCommands: string } {
  switch (scope.kind) {
    case "uncommitted":
      return {
        scopeText:
          "All pending (uncommitted) changes in this repository: staged, unstaged, and untracked files, relative to HEAD.",
        diffCommands: [
          "- `git status --porcelain=v1` — the full change list (untracked = `??`)",
          "- `git diff HEAD --stat`, then `git diff HEAD -- <file>` per file",
          "- untracked source files: read them in full with the Read tool",
        ].join("\n"),
      };
    case "staged":
      return {
        scopeText:
          "The STAGED changes only (the git index vs HEAD). Unstaged and untracked edits are out of scope — use them only as context.",
        diffCommands: [
          "- `git diff --cached --stat`, then `git diff --cached -- <file>` per file",
          "- `git status --porcelain=v1` — what else is in flight (context only, not under review)",
        ].join("\n"),
      };
    case "lastCommit":
      return {
        scopeText: "The single most recent commit (HEAD). Working-tree changes are not in scope.",
        diffCommands: [
          "- `git show HEAD --stat`",
          "- `git show HEAD -- <file>` per file",
        ].join("\n"),
      };
    case "commits":
      return {
        scopeText: `The last ${scope.count} commits — from ${scope.fromSha.slice(0, 7)} ("${scope.fromTitle}") through HEAD. Working-tree changes are not in scope.`,
        diffCommands: [
          `- \`git log ${scope.baseSha}..HEAD --oneline\` — the commits under review`,
          `- \`git diff ${scope.baseSha}..HEAD --stat\`, then \`git diff ${scope.baseSha}..HEAD -- <file>\` per file`,
        ].join("\n"),
      };
    case "branch":
      return {
        scopeText: `All work on this branch relative to \`${scope.base}\` (merge-base range \`${scope.base}...HEAD\`), plus any uncommitted changes on top of it.`,
        diffCommands: [
          `- \`git log ${scope.base}..HEAD --oneline\` — the commits under review`,
          `- \`git diff ${scope.base}...HEAD --stat\`, then \`git diff ${scope.base}...HEAD -- <file>\` per file`,
          "- `git status --porcelain=v1` — uncommitted stragglers (untracked = `??`); review those too",
        ].join("\n"),
      };
    case "pr":
      return {
        scopeText: `Pull request #${scope.number} — "${scope.title}". The PR head may not be checked out locally: \`gh pr diff\` is the source of truth for the change; the local tree is context.`,
        diffCommands: [
          `- \`gh pr view ${scope.number}\` — title/description context`,
          `- \`gh pr diff ${scope.number}\` — the full diff under review`,
          "- read surrounding local files where they match the diff",
        ].join("\n"),
      };
  }
}

export async function buildPrompt(scope: ReviewScope): Promise<string> {
  const template = await Bun.file(join(import.meta.dir, "..", "..", "prompts", "review.md")).text();
  const { scopeText, diffCommands } = scopeBlocks(scope);
  // Function replacers: string replacements interpret $&, $`, $' etc. in dynamic text.
  return template.replace("{{SCOPE}}", () => scopeText).replace("{{DIFF_COMMANDS}}", () => diffCommands);
}

const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const assistantEventSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});

const resultEventSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
});

export interface ReviewToolEvent {
  tool: string;
  arg: string;
}

export interface ReviewOutcome {
  result: ReviewResult;
  verdict: Verdict;
  costUsd: number | null;
  durationMs: number | null;
}

export interface ReviewOptions {
  model?: string;
  effort?: string;
}

export interface ReviewJob {
  outcome: Promise<ReviewOutcome>;
  cancel: () => void;
}

function shortToolInput(input: Record<string, unknown>): string {
  for (const key of ["file_path", "command", "pattern", "path", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 90 ? `${value.slice(0, 87)}...` : value;
    }
  }
  return "";
}

export function startReview(
  root: string,
  scope: ReviewScope,
  opts: ReviewOptions,
  onTool: (e: ReviewToolEvent) => void,
): ReviewJob {
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? DEFAULT_EFFORT;
  const settingsPath = join(import.meta.dir, "..", "..", "prompts", "reviewer-settings.json");

  let killed = false;
  let pid: number | null = null;
  const cancel = (): void => {
    if (killed) return;
    killed = true;
    if (pid !== null) treeKill(pid);
  };

  const outcome = (async (): Promise<ReviewOutcome> => {
    const prompt = await buildPrompt(scope);
    const exe = process.platform === "win32" ? "claude.cmd" : "claude";
    // Prompt goes in over stdin: Windows argv mangles JSON, so keep argv to simple tokens.
    const proc = Bun.spawn(
      [
        exe,
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--model", model,
        "--effort", effort,
        "--permission-mode", "dontAsk",
        "--settings", settingsPath,
        "--disable-slash-commands",
      ],
      { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    pid = proc.pid;
    const untrack = trackProcess({ pid: proc.pid, kill: cancel, exited: proc.exited });
    if (killed) treeKill(proc.pid);

    proc.stdin.write(prompt);
    await proc.stdin.end();

    let resultText: string | null = null;
    let costUsd: number | null = null;
    let durationMs: number | null = null;
    let resultIsError = false;

    const handleLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const assistant = assistantEventSchema.safeParse(parsed);
      if (assistant.success) {
        for (const block of assistant.data.message.content) {
          const tool = toolUseBlockSchema.safeParse(block);
          if (tool.success) onTool({ tool: tool.data.name, arg: shortToolInput(tool.data.input) });
        }
        return;
      }
      const result = resultEventSchema.safeParse(parsed);
      if (result.success) {
        resultText = result.data.result ?? null;
        costUsd = result.data.total_cost_usd ?? null;
        durationMs = result.data.duration_ms ?? null;
        resultIsError = result.data.is_error ?? result.data.subtype !== "success";
      }
    };

    const stderrPromise = new Response(proc.stderr).text();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      const tail = (buffer + decoder.decode()).trim();
      if (tail.length > 0) handleLine(tail);

      const stderr = await stderrPromise;
      const exitCode = await proc.exited;

      if (resultText === null || resultIsError || exitCode !== 0) {
        const detail = stderr.trim().length > 0 ? stderr.trim().slice(-2000) : (resultText ?? "no result event");
        throw new Error(`reviewer process failed (exit ${exitCode}): ${detail}`);
      }

      const result = reviewResultSchema.parse(extractJsonObject(resultText));
      return { result, verdict: computeVerdict(result), costUsd, durationMs };
    } finally {
      untrack();
    }
  })();

  return { outcome, cancel };
}

export async function resolveScopeFlags(
  root: string,
  flags: { staged?: boolean; lastCommit?: boolean; last?: number; branch?: boolean; pr?: number },
): Promise<ReviewScope> {
  const chosen = [
    flags.staged === true,
    flags.lastCommit === true,
    flags.last !== undefined,
    flags.branch === true,
    flags.pr !== undefined,
  ].filter(Boolean).length;
  if (chosen > 1) throw new Error("pick one scope flag");

  if (flags.staged === true) return { kind: "staged" };
  if (flags.lastCommit === true) return { kind: "lastCommit" };

  if (flags.last !== undefined) {
    if (flags.last < 1) throw new Error("--last needs a count of at least 1");
    const commits = await recentCommits(root, flags.last);
    if (commits.length === 0) throw new Error("no commits to review");
    const count = Math.min(flags.last, commits.length);
    const from = commits[count - 1];
    if (from === undefined) throw new Error("no commits to review");
    return {
      kind: "commits",
      fromSha: from.sha,
      baseSha: await parentOr(root, from.sha),
      count,
      fromTitle: from.title,
    };
  }

  if (flags.branch === true) {
    const base = await mainBranch(root);
    if (base === null) throw new Error("could not determine the main branch (no origin/HEAD, main, or master)");
    const branch = await currentBranch(root);
    if (branch === base || `origin/${branch}` === base) throw new Error(`already on ${base} — nothing to compare`);
    return { kind: "branch", base };
  }

  if (flags.pr !== undefined) {
    const title = await prTitle(root, flags.pr);
    if (title === null) throw new Error(`gh could not find PR #${flags.pr} (is gh installed and authed?)`);
    return { kind: "pr", number: flags.pr, title };
  }

  return { kind: "uncommitted" };
}

/** The reviewer's final message must be a bare JSON object; tolerate stray prose/fences around it. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`reviewer output contained no JSON object:\n${text.slice(0, 800)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}
