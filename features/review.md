# Review (sal-review)

> Status: **done** · Last updated: 2026-08-06

## What / Why

A clean-context code review of whatever repo you're in, run by a **fresh headless Claude Code process** (`claude-opus-4-8 --effort high`) with zero conversation taint — the reviewing session never sees your working context. Findings are ranked blocker/warn/nit; a passing review can be committed from the screen with the reviewer's own commit message. Absorbed from the retired standalone `sal-review` repo; the ledger it used to keep (`.sal-review/` in target repos) was deliberately dropped — every review is fresh.

## Behavior spec

- `review` (global bin, works in any repo) opens the TUI on the scope picker; `destedtui --review` and the "Review" menu tile do the same. Not a git repo / no commits yet → clear error.
- Scope picker rows, each with a live badge and disabled when empty: **Uncommitted changes** (staged+unstaged+untracked vs HEAD, `N files`), **Staged only** (`N files`), **Last commit** (HEAD sha + title), **Recent commits** (sub-picker of the last 15 commits — choosing one reviews it **and everything after it** through HEAD), **Branch vs main** (`N commits`, disabled on main), **Pull request** (sub-picker of open PRs via `gh pr list`; "gh unavailable" when gh is missing/unauthed).
- Scope flags deep-link straight into a running review: `review --staged | --last-commit | --last <n> | --branch | --pr <n>`.
- While running: spinner + elapsed, live counters (`N tool calls · M files read`), and a streaming feed of the reviewer's tool calls (glyph + tool + argument). `esc` cancels (tree-kills the reviewer).
- Done: ascii-font **PASS** (green) / **BLOCKED** (red) banner, blocker/warn/nit counts + cost + duration, wrapped summary (max 6 rows), **merge & deploy notes** (migration/deploy-order risk, seeds/env follow-ups, PR hygiene — a separate `notes` array in the contract so operational guidance doesn't get squeezed into findings), then scrollable findings (severity chip, `file:line`, title, detail, optional `↪ fix:`). Verdict is computed by the CLI (any blocker ⇒ blocked), never trusted from the model. The prompt pushes exhaustive minors, flags visibility/permission widening, and fact-checks changed docs.
- Commit gate (only for dirty-tree scopes: uncommitted / staged / branch): `c` commits on a pass — staged scope commits the index as-is, the others `git add -A` first — using the reviewer's commit message. Blocked → `c` is disabled and a red strip warns; `f` force-commits anyway. `r` re-runs the same scope.
- Headless mode for scripts and the `/sal-review` Claude skill: `review --headless [scope]` prints the classic ANSI report (no TUI, no commit); `--dry-run` prints the assembled prompt. Exit codes: 0 pass · 1 blocked · 2 error. `--model`/`--effort` override the pinned reviewer.
- The reviewer is **read-only by construction**: `--permission-mode dontAsk` + an allowlist (`prompts/reviewer-settings.json`) of Read/Grep/Glob, read-only git, `gh pr view/diff/checks`, and typecheck/lint commands, with mutations explicitly denied. Never add Edit/Write/mutating-git to it.

## Touchpoints

| Part | File |
| --- | --- |
| `review` bin (args, headless vs TUI boot) | `src/review.tsx` |
| Screen (picker, stream, report, commit gate) | `src/screens/Review.tsx` |
| Engine (schemas, scopes, prompt, claude spawn) | `src/lib/review.ts` |
| git + gh helpers | `src/lib/reviewGit.ts` |
| Headless report | `src/lib/reviewHeadless.ts` |
| Reviewer prompt + permissions | `prompts/review.md`, `prompts/reviewer-settings.json` |
| Claude Code skill wrapper | `~/.claude/skills/sal-review/SKILL.md` |
