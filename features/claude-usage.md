# Claude usage — cost, tokens, sessions and a timeline per project

> Status: shipped 2026-10-04.

## What it does

Reads every Claude Code transcript under `~/.claude/projects` and shows what each
project cost, when you worked on it, and every session. Dollars are **API-equivalent
list prices**: a Max plan isn't billed per token, so the figure is what the API would
have charged. Tokens are always shown next to it.

Surfaces: the Claude Usage screen (menu tile, `destedtui --claude`, typing `claude` in
the picker) and `destedtui --usage [--days 1|7|30|90|all] [--project <name>] [--json]`
for Claude sessions and scripts.

## Files

| Piece | Path |
| --- | --- |
| Price table, cost of a token split, model short names | `src/lib/claude/pricing.ts` |
| Transcript scanner + incremental cache (zod) | `src/lib/claude/scan.ts` |
| Scanner off the UI thread | `src/lib/claude/scanWorker.ts` |
| Aggregation: projects, sessions, days, heatmap, active time | `src/lib/claude/view.ts` |
| `--usage` printer | `src/lib/claude/cli.ts` |
| Screen | `src/screens/ClaudeUsage.tsx` |
| Headless frames | `scripts/snap-claude.tsx` |

## Data

`~/.destedtui/claude-usage.json` (~16 MB): per transcript its size, mtime, the byte
offset of its last complete line, session id, cwd, branch, AI title, prompt count,
sorted activity minutes, and one flat 9-number tuple per API message
(`[hash, ts, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, fast]`).
No dollar figures are stored. `CLAUDE_PROJECTS_DIR` overrides the source folder.

## Behavior spec

- **First open** reads all ~18 GB of transcripts in a Worker (~55s) behind a spinner and
  a `scanning transcripts n/N · x GB read` status line. Later opens paint from the cache
  at once, then a warm scan (a stat per file) brings it current. An unchanged file is
  skipped, a grown one is read from its saved offset, and a shrunk one is reparsed.
- It rescans every 2 minutes while open, and the `↻ rescan` button rescans now.
- **Everything is a button.** An action bar under the detail strip holds the view's
  controls; `↻ rescan` and `← back` sit flush right. Keys (`1-4`, `d`, `s`, `w`, `/`,
  `g`, `r`) still work as silent aliases, but the footer only advertises click,
  ↑↓, enter and esc. Actions that don't fit a narrow terminal drop off the end.
- **A message is counted once.** Claude Code writes one line per content block, all
  carrying the same usage. Within a file, `message.id + requestId` dedupe and the copy
  with the most output tokens wins. Across files (resumed sessions copy history), the
  oldest file keeps the message.
- **Price** = input × in + output × out + cache read × the model's read rate + 5-minute
  writes × 1.25 in + 1-hour writes × 2 in, all ×2 in fast mode. Unknown models are priced
  as the newest of their family, and the status line names them. `<synthetic>` costs $0.
- **Project** = the top-level `projectsRoot()` folder of the session's cwd (monorepo
  subfolders and worktrees roll up). A cwd inside a session scratchpad
  (`…/Temp/claude/G--code-sigil/…`) maps back to the project its slug names. `G:\code`
  itself shows as `G:\code`, the home folder as `~`, and anything else as its path.
  A subagent's spend counts toward its parent session's project.
- **Active time**: each minute with transcript activity counts until the next one,
  capped at 5 minutes. Minutes are unioned across sessions, so two parallel sessions
  don't double a day's hours.
- **Range** (click a chip): today, 7d, 30d (default), 90d or all time, in
  local days. It filters every view.
- **1 projects**: cost, tokens, sessions, active days, active time, a daily sparkline
  (14–30 days depending on width), last used, and the top two models by cost share.
  Bar: a `sort cost | recent | active` segmented control, `≡ sessions`, `↪ open folder`
  (cds there). Enter or a row click opens that project's sessions.
- **2 timeline**: rows are projects by cost; columns are days (1–4 cells wide) or, with
  `show days | weeks` set to weeks, Monday-start weeks (up to 12 cells, the first and
  last clipped to the range), sized to fill the panel. A cell is `·` when nothing
  happened, otherwise `░▒▓█` on a sqrt scale of the busiest cell in view. `◀ ▶` (or ←→)
  move the column cursor, `« 7d`/`7d »` (`4w` in weeks) jump, and the grid scrolls to
  keep it in view. The detail strip shows that project-day or project-week: cost,
  active time, sessions touching it, their titles, and the whole day's/week's total.
  `≡ sessions` (or enter) shows those sessions; a cell click moves the cursor.
- **3 sessions**: newest activity first, with last active, active time, project, AI
  title, cost, tokens and subagent count. `⌕ filter` types a filter by title, project or
  id prefix; `✕ clear filter` drops it and any drill-down scope (project, day or week).
  `▶ resume` (or the row's `▶`, or enter) resumes it: the TUI quits, cds to the session's cwd and runs
  `claude --resume <id>`. esc clears a filter before it leaves the screen.
- **4 days**: newest first, with cost, active time, sessions, tokens and projects by
  cost; the detail strip lists every project with its active time. `≡ sessions` or a
  row click shows that day's sessions.
- Claude Code's own background Haiku calls (titles and the like) never reach a
  transcript, so mixed sessions read ~5% under its `cost-state` total. Single-model
  sessions match it to the cent.

## Open questions

- Transcripts Claude Code has already deleted (`cleanupPeriodDays`) are gone. The
  cache keeps entries for files that vanish *after* the first scan.
