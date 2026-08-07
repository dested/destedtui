# destedtui — CliffNotes

> Living map of the project. Read this before any coding session.
> Last updated: 2026-08-06.

## What this is

Personal dev-project TUI for dested. Three jobs: (1) a **project picker** that lists everything in `g:\code` ranked by how often you open it, fuzzy-filters it, carries your saved command shortcuts, and `cd`s the shell there — it auto-launches in every new terminal that starts in `g:\code`; (2) `cd` into any project and run `destedtui` for per-project utilities — a monorepo-aware package.json script runner and Postgres backup/restore driven by `.env` `DATABASE_URL`s (pg client tools auto-downloaded per server major version so dumps are never version-mismatched); (3) a second global bin, **`review`** — a clean-context code review of the current repo by a fresh headless `claude-opus-4-8` process, with scope picking (uncommitted/staged/commits/branch/PR), a streaming activity feed, and a gated in-TUI commit. See [features/review.md](features/review.md).

## Quick Reference

- **Run:** `bun run dev` in this repo, or `destedtui` anywhere (globally linked via `bun link`)
- **Entry point:** `src/index.tsx` → arg parsing → `createCliRenderer` → `<App/>`
- **Type-check:** `bun x tsc --noEmit`
- **Test:** no test runner — see `verify.md` for smoke/e2e scripts
- **CLI flags:** `--projects`/`-p`/`--cd`, `--startup`, `--term`, `--backup`, `--restore`, `--local`, `--pull`, `--review` (jump straight to a screen), `--install-shell`, `--help`, `--version`
- **Second bin — `review`:** works in ANY repo; no args = TUI scope picker; `--staged`/`--last-commit`/`--last <n>`/`--branch`/`--pr <n>` deep-link; `--headless` (+ `--dry-run`, `--model`, `--effort`) prints the report without a TUI for the `/sal-review` Claude skill — exit 0 pass / 1 blocked / 2 error
- **Terminal multiplexer (`term`):** interactive shells & `claude` sessions in panes; PTYs run in a **Node sidecar** (`ptyhost/host.mjs`) because Bun can't drive Windows ConPTY. Needs `node` on PATH.
- **Shell integration:** `destedtui --install-shell` → `shell/install.ps1` adds a marked block to the real `$PROFILE` that dot-sources `shell/destedtui.ps1` (`proj`/`pj` + auto-launch, `dested` = the bin under a short name, `term` = jump into the multiplexer here)
- **Config / state:** `~/.destedtui/config.json` (localhost pg preset, `projectOpens` frecency, `commands` shortcuts, `termNotes` per-terminal notes keyed by title, optional `projectsRoot`)
- **Tool cache:** downloaded pg binaries live in `~/.destedtui/pg/<major>/bin`

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime / pkg mgr | Bun | shebang `#!/usr/bin/env bun`; bin registered by `bun link` |
| TUI framework | @opentui/core + @opentui/react 0.4.3 | lowercase JSX intrinsics (`<box>`, `<text>`, …), flexbox layout |
| UI lib | React 19 | `createRoot(renderer).render()` from @opentui/react |
| Postgres client | `pg` (node-postgres) | version detect + admin queries only; dumps use real pg_dump |
| Zip | fflate | fully streaming (Zip/Unzip classes), never buffers dumps |
| Validation | zod 4 | reviewer output contract + gh JSON parsing (`lib/review.ts`, `lib/reviewGit.ts`) |
| Terminals | `@lydell/node-pty` (in a Node sidecar) + `@xterm/headless` | Bun can't ConPTY-write on Windows → sidecar; xterm = VS Code's emulator |
| Deploy | github.com/dested/destedtui | personal tool, no CI |

## Directory structure

```
prompts/
  review.md             reviewer prompt template ({{SCOPE}}, {{DIFF_COMMANDS}} placeholders)
  reviewer-settings.json reviewer permissions: read-only allowlist + explicit deny of mutations
ptyhost/
  host.mjs              Node sidecar: owns @lydell/node-pty, JSON-over-stdio, multiplexes every pane's PTY
shell/
  destedtui.ps1         `proj`/`pj` wrapper (temp-file cd handoff) + autostart guard + `dested` alias + `term` fn
  install.ps1           idempotent marked block into the real $PROFILE (-Uninstall removes it)
src/
  index.tsx             CLI entry: --help/--version/--projects/--backup/--restore/--local/--pull/--review/--install-shell
  review.tsx            the `review` bin: scope flags, --headless path, or boots the TUI on the review route
  App.tsx               Route stack (push/pop), discovery kickoff, chooseProject (cd + exit), global ctrl+c quit
  routes.ts             Route union type (backup/restore carry optional presets)
  theme.ts              T = Tokyo Night palette + SPINNER_FRAMES (single source of color truth)
  components/
    TerminalView.tsx    custom opentui Renderable: blits an xterm-headless cell grid via setCell (+ xterm-256 palette); wheel = scrollback / forward-to-app
    Header.tsx          ascii-font "DESTED" gradient header + cwd (leaf folder bold-teal behind ⌂, parent dim)
    Footer.tsx          keybind hint bar (Hint = [key, label])
    ListPicker.tsx      THE list primitive: windowed, keyboard+mouse, badges, disabled rows
    ProjectCard.tsx     one project as a 6-row card + dev/claude buttons (CARD_HEIGHT, STACK_COLORS, Button)
    CommandCard.tsx     a saved command shortcut in the same card rect: run / edit / delete
    CommandEditor.tsx   add-edit form + delete confirm; they REPLACE the grid, never overlay it
    ActionCard.tsx      a built-in tui action (e.g. "startup") as a card in the picker grid
    Highlight.tsx       one padded line with the fuzzy-matched characters picked out
    ProgressBar.tsx     pct bar used by backup/restore/pull
  screens/
    MainMenu.tsx        utility tiles incl. disabled "coming soon" rows
    Startup.tsx         dev-fleet dashboard: rail of app cards (dot/spinner/buttons) + live console pane
    Term.tsx            terminal multiplexer: rail of session CARDS (rename ✎, close ✕, live age) + active PTY pane with a note strip above it, nav/input modes, ctrl+b leader. No auto-spawn — starts empty.
    Projects.tsx        g:\code card grid: own type-ahead, hover, wheel, click/enter = cd + quit
    Scripts.tsx         fuzzy-filterable flat list of every package script
    ProcessView.tsx     live script output: scrollbox + stickyScroll, spinner, kill
    Backup.tsx          pick db (or presetUrl) → event log + progress → done/error
    Restore.tsx         source (project zip | file path) → target (origin server | localhost existing/new) → run
    LocalDb.tsx         localhost DB browser: list/create/drop + edit connection; launches backup/restore per DB
    Pull.tsx            pick .env db → name local target → dump+restore into localhost, one shot
    Review.tsx          code review: scope picker (live badges) → streaming reviewer feed → PASS/BLOCKED report + commit gate
  lib/
    startup.ts          the dev-fleet supervisor: APPS registry + module-level `startup` manager (start/stop/restart/all)
    term.ts             terminal multiplexer brain: `term` singleton — sessions, xterm emulators, active/mode, create/close, per-session notes (persist by title)
    ptyhost.ts          Bun-side client for the Node pty sidecar: spawns it, frames JSON, tree-kills it on exit
    projects.ts         scan g:\code, stack detect, frecency (own opens + zoxide), matchProject, inspectProject
    fuzzy.ts            fzf-style scorer: subsequence + word-start/camelCase/acronym bonuses, match positions
    commands.ts         saved command shortcuts (config `commands`), load/save/upsert/remove, matchCommand
    text.ts             fit/pad/wrap — cell arithmetic every card line goes through
    cd.ts               DESTEDTUI_CD_FILE handoff + the "➜ cd <dir>" line printed after teardown
    config.ts           ~/.destedtui/config.json read/patch (shared by pglocal + projects)
    discovery.ts        walk tree: package.json scripts, .env DATABASE_URLs, PM detection
    pgurl.ts            parse postgres:// URL (PgConn), withDatabase()
    pgtools.ts          server version detect, EDB binary download/cache, adminQuery, adminRows, psql path
    pglocal.ts          localhost conn config (~/.destedtui/config.json), list/create/drop local DBs
    backup.ts           startBackup(): connect → tools → pg_dump -Fc → streamed zip
    restore.ts          listBackupZips(), startRestore(source, target): extract/zip|file → drop/create → pg_restore|psql
    pull.ts             startPull(): dump source → create/overwrite localhost DB → pg_restore, no zip
    review.ts           review engine: zod result contract, ReviewScope union, prompt assembly, startReview (spawns headless claude)
    reviewGit.ts        git + gh subprocess helpers for review (counts, recent commits, main-branch detect, commit, open PRs)
    reviewHeadless.ts   --headless path: ANSI report renderer + runHeadless (exit codes)
    run.ts              Bun.spawn wrappers: runScript/runCommand (line streaming), runTool, openInChrome, treeKill, trackProcess, killAll
    zip.ts              fflate streaming: createBackupZip, readZipMetadata, extractZipEntry
```

## File map (concept → path)

| Concept / task | Location |
| --- | --- |
| Add a new utility screen | `src/screens/`, route in `src/routes.ts`, wire in `src/App.tsx`, tile in `MainMenu.tsx` |
| The terminal multiplexer | `src/screens/Term.tsx` (UI) + `src/lib/term.ts` (`term` singleton) + `src/components/TerminalView.tsx` (render) + `ptyhost/host.mjs` (PTYs) |
| How a keystroke reaches a terminal | `keyToBytes` in `Term.tsx` → `term.write` → `ptyhost.ts` → sidecar → node-pty. nav vs input mode + `ctrl+b` leader live in `Term.tsx` |
| Modified keys to a terminal (ctrl+←/→, shift/alt arrows) | `keyToBytes` in `Term.tsx` — xterm modifier param `1+shift+2·alt+4·ctrl` |
| Mouse wheel in a terminal | `TerminalView.tsx` → `handleScroll` (SGR wheel to mouse-apps / arrows to pagers / local scrollback via `viewportY`) |
| Notes about a terminal / claude | `TermSession.note` + `term.setNote` in `lib/term.ts` (persist `termNotes` by title); `NoteStrip` + `t`/`ctrl+b t` in `Term.tsx` |
| The `dested` / `term` shell shortcuts | `shell/destedtui.ps1` (`Set-Alias dested`, `function term`) |
| Terminal colors / cursor / cell drawing | `src/components/TerminalView.tsx` (`renderSelf` → `setCell`, `PALETTE`, attribute mapping) |
| Why terminals need a Node sidecar | `decisions.md` 2026-08-01 (Bun can't ConPTY-write on Windows); the sidecar is `ptyhost/host.mjs` |
| The `review` code reviewer | `src/screens/Review.tsx` (UI) + `src/lib/review.ts` (engine) + `src/review.tsx` (bin) — spec in `features/review.md` |
| Review scopes / what the reviewer is told | `scopeBlocks` + `buildPrompt` in `src/lib/review.ts` + `prompts/review.md` |
| Reviewer permissions (read-only guarantee) | `prompts/reviewer-settings.json` — never add Edit/Write/mutating-git to its allow list |
| The `/sal-review` Claude skill | `~/.claude/skills/sal-review/SKILL.md` → `review --headless` |
| The startup dev-fleet dashboard | `src/screens/Startup.tsx` (UI) + `src/lib/startup.ts` (the `startup` supervisor singleton) |
| Which apps the dashboard boots / their ports | `src/lib/startup.ts` → `SPECS` (folder, command, url, desktop flag) |
| A built-in picker action (type "startup") | `ACTIONS` + `matchAction` in `src/screens/Projects.tsx`, card in `components/ActionCard.tsx` |
| Open a URL in Chrome | `src/lib/run.ts` → `openInChrome` |
| Run an arbitrary long-lived command | `src/lib/run.ts` → `runCommand` (tracked in `running`, tree-killed on quit) |
| Which folders show in the picker / how they rank | `src/lib/projects.ts` (`scanProjects`, `SKIP`, `decay`, `zoxideScores`) |
| How the filter matches (`frop` → `frozen-ropes`) | `src/lib/fuzzy.ts` (bonus constants at the top), `matchProject` in `lib/projects.ts` |
| Command shortcuts (`cc` → `bunx ccusage`) | `src/lib/commands.ts` (+ `DEFAULTS`), cards in `CommandCard.tsx`, form in `CommandEditor.tsx` |
| Where a shortcut runs | `runHere` in `App.tsx` — the shell's cwd, never a project dir |
| Stack badge detection (next/rust/go/…) | `src/lib/projects.ts` → `detectStack`; colors in `ProjectCard.tsx` → `STACK_COLORS` |
| Card size / grid columns | `ProjectCard.tsx` (`CARD_HEIGHT`, `CARD_MIN_WIDTH`), geometry block in `Projects.tsx` |
| Ignoring `cd `/paths typed into the filter | `src/lib/projects.ts` → `parseQuery`, `NAV_PREFIX` |
| The picker's cd handoff | `src/lib/cd.ts` + `chooseProject` in `App.tsx` + `proj` in `shell/destedtui.ps1` |
| What the card buttons run | `detectStack` → `devCommand` in `lib/projects.ts`; `CLAUDE_COMMAND` in `ProjectCard.tsx` |
| When the picker auto-opens | `Test-DestedTuiAutostart` in `shell/destedtui.ps1` |
| Projects root (default `g:\code`) | `projectsRoot()` — `DESTEDTUI_PROJECTS_ROOT` > config `projectsRoot` > platform default |
| Colors / look | `src/theme.ts` (+ `ui.md`) |
| What gets discovered in a project | `src/lib/discovery.ts` (SKIP_DIRS, DB_URL_KEYS, maxDepth=4) |
| Supported pg versions / download URLs | `src/lib/pgtools.ts` → `EDB_CANDIDATES`, `MAJOR_ORDER` |
| Backup zip name/contents | `src/lib/backup.ts` (`pgbackup-<db>-<ts>.zip`, `<db>.dump` + `metadata.json`) |
| Restore safety (drop/confirm) | `src/lib/restore.ts` + confirm UI in `src/screens/Restore.tsx` |
| Localhost connection preset | `src/lib/pglocal.ts` (`~/.destedtui/config.json` → `localhost`); edit UI in `LocalDb.tsx` |
| List/create/drop local DBs | `src/lib/pglocal.ts` (uses `adminRows`/`adminQuery`) |
| Restore into localhost / from a file | `Restore.tsx` (target = localhost; source = file path) → `restore.ts` |
| Clone remote → localhost | `src/lib/pull.ts` + `src/screens/Pull.tsx` |
| Restore a raw .sql (not custom) | `restore.ts` `dumpKind()` → `psql -f` (else `pg_restore`) |
| Process spawning / killing | `src/lib/run.ts` |
| Keybind hints | each screen's `<Footer hints=…>` |

## Architecture

Single-process TUI. `App` holds a route **stack** (push/pop = navigation; esc pops). Discovery runs once on boot (sync fs walk, deferred a tick for instant first paint) and is passed down to screens. Long operations (backup/restore) are plain async functions in `lib/` that emit typed events; screens subscribe and render the event log — no state library. Child processes stream stdout/stderr line-by-line into React state (batched every 80ms).

## Key types

| Type | Where | Purpose |
| --- | --- | --- |
| `Discovery` / `PackageInfo` / `DatabaseInfo` | `lib/discovery.ts` | scan results fed to all screens |
| `Route` | `routes.ts` | navigation union |
| `PgConn` | `lib/pgurl.ts` | parsed DATABASE_URL |
| `PgTools` / `ServerInfo` | `lib/pgtools.ts` | resolved binaries + detected server |
| `BackupEvent` / `RestoreEvent` | `lib/backup.ts` / `lib/restore.ts` | progress stream to UI |
| `ProcHandle` | `lib/run.ts` | pid + kill() + exited promise |
| `ProjectInfo` / `ProjectDetail` / `SortMode` | `lib/projects.ts` | picker rows, git pane, sort cycling |
| `ReviewScope` / `ReviewResult` / `ReviewOutcome` | `lib/review.ts` | review scope union, the reviewer's zod-parsed output, verdict+cost |

## Gotchas & hard rules

- **useKeyboard fires globally** for every mounted component — only mount one screen at a time, and beware double-handling enter: an `<input onSubmit>` and a `useKeyboard("return")` both fire on the same keypress (already bitten twice; pick one owner per screen).
- **ListPicker `vimKeys` must stay off** on any screen with a text input (j/k would collide with typing).
- **Never buffer a dump in memory** — dumps can be multi-GB; all zip paths go through the streaming helpers in `lib/zip.ts`.
- pg_dump/pg_restore version must be ≥ server major (restore wants ==); that's what `EDB_CANDIDATES` + `ensureTools` guarantee. New pg major released → add candidates to both `EDB_CANDIDATES` and `MAJOR_ORDER`.
- `exitOnCtrlC: false` in the renderer — ctrl+c is handled in `App` (kills children via `killAll()` first). Don't re-enable.
- Windows script execution goes through `cmd.exe /d /s /c`, and kills via `taskkill /T /F` (plain `.kill()` orphans grandchildren).
- Literal ESC bytes in source files break this harness's edit tools — `ANSI_RE` in run.ts is built with `String.fromCharCode(0x1b)` on purpose.
- Restore runs `--no-owner --no-acl --role=<url user>` (deliberate — see decisions.md).
- **A box only paints the rect it occupies.** Rows removed by a filter, or a column that sizes to its content, leave the old pixels on screen. Anything whose size can change needs an explicit width/height (see `Projects.tsx` `listWidth`/`rows`) — this cost an afternoon.
- **Don't populate a list from an effect.** Scanning in `useState(() => ...)` (~50ms for 220 folders) beats an empty first frame, which paints torn rows.
- A screen that needs **left/right** keys can't mount a focused `<input>` — the textarea eats them as cursor moves. `Projects.tsx` captures printable `key.sequence` itself instead; that's also why it has no enter-ownership problem.
- `ListPicker` renders up to `visible` rows **plus** the `▲/▼ N more` counters — budget `visible + 2` lines or the counter lands on top of a row.
- **Several key events can land before React re-renders.** Anything that accumulates keystrokes must use the updater form (`setX(v => v + ch)`); a value-form `setState` reads the same stale state for every key in the batch and keeps only the last character. Cost an hour in the command editor.
- **Check a glyph's width before using it.** `⚡` is double-width and silently ate the `cmd` badge off the end of the command card. Single-cell glyphs only (see ui.md).
- **A bordered box's height must budget border 2 + padding 2 + its lines.** One row short and the top line is clipped away entirely with no error (the delete confirm lost its `⚠` line at `height: 5`).
- **Bun can't do PTYs on Windows** — `Bun.Terminal` throws "PTY not supported", and `node-pty` under Bun reads but its conin-pipe write (`net.Socket({fd})`) dies with `ERR_SOCKET_CLOSED`. That's why terminals run in a **Node sidecar** (`ptyhost/host.mjs`); the sidecar needs `node` on PATH. Don't try to move PTY I/O back into the Bun process.
- **Panes run YOUR pwsh with YOUR profile** (`SHELL_FILE` in `lib/term.ts` = `pwsh` → `powershell.exe` fallback), spawned with `DESTEDTUI_NO_AUTOSTART=1` so the profile's picker auto-launch doesn't recurse inside a pane. A claude pane is `pwsh -NoExit -Command "<claude>"`, not a keystroke write (races a slow profile). Never revert to `cmd.exe`.
- **The `term` manager (`lib/term.ts`) is a module-level singleton** — like `startup`, sessions survive leaving the workspace and die only on real quit. **Cleanup is triple-guarded** (each session = 1 pwsh + 1 conhost under the sidecar): graceful quit → `PtyHost` tree-kills the sidecar; sidecar tree-kills itself on stdin-EOF/shutdown (`taskkill /T`, reaps grandchildren); and a **PID watchdog** in `host.mjs` (handed the Bun pid, polls every 1.5s) self-destructs on hard TUI death — Windows doesn't reliably EOF the stdin pipe on `taskkill /F`. Verified 0 orphans both ways. Don't kill sessions from `Term.tsx` unmount.
- **Measuring term orphans: filter by process NAME, never by `CommandLine -like '*host.mjs*'`** — that pattern matches the very PowerShell/bash you spawn to run the query (their command line contains the search string), so you'll "find" phantom sidecars and even kill your own tool chain. Use `Name='node.exe'` + `*ptyhost*`, `Name='pwsh.exe'` + `*-NoLogo*`. (Cost 20 min of ghost-chasing.)
- **`TerminalView` repaints off two subscriptions, not React props**: per-session data (PTY output) + global (focus/mode). It's keyed by session id so switching panes remounts a fresh renderable rather than relying on opentui applying a changed `session` prop. `onResize` drives `term.resize` → the PTY's cols/rows.
- **In the terminal, ctrl+c belongs to the PTY** — `App.tsx` skips its global ctrl+c quit while `route.name === "term"`. Leave the workspace with `q`/`esc` (nav mode) or the `ctrl+b` leader.
- **Terminal input encoding uses `"\x1b"` string escapes, never literal ESC bytes** (`keyToBytes` in `Term.tsx`) — same harness constraint as `cd.ts`/`run.ts`.
- **The startup supervisor (`lib/startup.ts`) is a module-level singleton on purpose** — its dev servers must survive `esc`-ing out of the dashboard and only die on real quit (killAll). Do NOT kill them from `Startup.tsx`'s unmount effect, and don't move the state into the component. `openInChrome` is deliberately NOT added to `run.ts`'s `running` set — killing the tui shouldn't close your browser.
- **The reviewer child process is claude.cmd on Windows — argv is the enemy.** The prompt goes over **stdin** and spawn argv stays simple tokens (JSON/parens on a `.cmd` command line get mangled); permissions ride in via `--settings prompts/reviewer-settings.json`. Prompt template substitution must use **function replacers** (`.replace(x, () => v)`) — `$&`-class tokens in dynamic text silently corrupt string replacements. Reviewer output contract lives in BOTH `prompts/review.md` and `lib/review.ts` (`reviewResultSchema`) — change them together.
- The review verdict is **computed by the CLI** (any blocker ⇒ blocked) — never trusted from the model. The reviewer proc is registered via `trackProcess` so quit/ctrl+c tree-kills it like every other child.
- **Review output is judged against a raw Claude session** on the same diff (features/review.md "Quality bar"): coverage + merge/deploy notes matter as much as peak findings, and the TUI must never truncate model output. Re-benchmark after material prompt changes.
- A `.git` folder's own mtime is worthless as "last touched" (any passing `git status` bumps it, so all 221 repos read as "just now"); `.git/logs/HEAD` is the honest signal.

## Status

- **Done** [Project picker](features/project-picker.md) · [Script runner](features/script-runner.md) · [PG backup](features/pg-backup.md) · [PG restore](features/pg-restore.md) — e2e verified against local PostgreSQL 18.3
- **Done** Startup dashboard — boots/babysits the 5 dev servers (todolist/deck/drydock/chirptime/sal-widgets); tile + `--startup` + typing "startup" in the picker. Layout verified in tmux; live console + Chrome launch not auto-smoke-tested (would spawn real servers).
- **Done** Terminal multiplexer (`term`) — interactive shells & `claude` sessions in panes, add/switch/close, mouse-driven, guaranteed cleanup. tile + `--term` + typing "term" in the picker. Verified end-to-end in tmux (typed commands run, per-pane isolation, 0 orphans on quit/abrupt-close). Live `claude` spawn not auto-tested (would burn tokens) — plumbing is identical to shells.
- **Done** [Review](features/review.md) — clean-context `claude-opus-4-8` code review as a second global bin (`review`): scope picker (uncommitted/staged/last commit/recent commits/branch/PR via gh), streaming tool feed, PASS/BLOCKED report, gated commit, `--headless` for the `/sal-review` skill. Absorbed from the retired `G:\code\sal-review` repo 2026-08-06; ledger dropped (see decisions.md).
- **Not built** (menu shows "coming soon"): Git dashboard, Port killer, .env inspector, node_modules nuker
- **Next:** whichever coming-soon tile the user picks
