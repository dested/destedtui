# destedtui — CliffNotes

> Living map of the project. Read this before any coding session.
> Last updated: 2026-07-30.

## What this is

Personal dev-project TUI for dested. Two jobs: (1) a **project picker** that lists everything in `g:\code` ranked by how often you open it, fuzzy-filters it, carries your saved command shortcuts, and `cd`s the shell there — it auto-launches in every new terminal that starts in `g:\code`; (2) `cd` into any project and run `destedtui` for per-project utilities — a monorepo-aware package.json script runner and Postgres backup/restore driven by `.env` `DATABASE_URL`s. The unusual part of the latter: pg client tools are auto-downloaded per server major version (EDB builds) so dumps are never version-mismatched.

## Quick Reference

- **Run:** `bun run dev` in this repo, or `destedtui` anywhere (globally linked via `bun link`)
- **Entry point:** `src/index.tsx` → arg parsing → `createCliRenderer` → `<App/>`
- **Type-check:** `bun x tsc --noEmit`
- **Test:** no test runner — see `verify.md` for smoke/e2e scripts
- **CLI flags:** `--projects`/`-p`/`--cd`, `--backup`, `--restore`, `--local`, `--pull` (jump straight to a screen), `--install-shell`, `--help`, `--version`
- **Shell integration:** `destedtui --install-shell` → `shell/install.ps1` adds a marked block to the real `$PROFILE` that dot-sources `shell/destedtui.ps1` (`proj`/`pj` + auto-launch)
- **Config / state:** `~/.destedtui/config.json` (localhost pg preset, `projectOpens` frecency, `commands` shortcuts, optional `projectsRoot`)
- **Tool cache:** downloaded pg binaries live in `~/.destedtui/pg/<major>/bin`

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime / pkg mgr | Bun | shebang `#!/usr/bin/env bun`; bin registered by `bun link` |
| TUI framework | @opentui/core + @opentui/react 0.4.3 | lowercase JSX intrinsics (`<box>`, `<text>`, …), flexbox layout |
| UI lib | React 19 | `createRoot(renderer).render()` from @opentui/react |
| Postgres client | `pg` (node-postgres) | version detect + admin queries only; dumps use real pg_dump |
| Zip | fflate | fully streaming (Zip/Unzip classes), never buffers dumps |
| Deploy | github.com/dested/destedtui | personal tool, no CI |

## Directory structure

```
shell/
  destedtui.ps1         `proj`/`pj` wrapper (temp-file cd handoff) + autostart guard
  install.ps1           idempotent marked block into the real $PROFILE (-Uninstall removes it)
src/
  index.tsx             CLI entry: --help/--version/--projects/--backup/--restore/--local/--pull/--install-shell
  App.tsx               Route stack (push/pop), discovery kickoff, chooseProject (cd + exit), global ctrl+c quit
  routes.ts             Route union type (backup/restore carry optional presets)
  theme.ts              T = Tokyo Night palette + SPINNER_FRAMES (single source of color truth)
  components/
    Header.tsx          ascii-font "DESTED" gradient header + cwd
    Footer.tsx          keybind hint bar (Hint = [key, label])
    ListPicker.tsx      THE list primitive: windowed, keyboard+mouse, badges, disabled rows
    ProjectCard.tsx     one project as a 6-row card + dev/claude buttons (CARD_HEIGHT, STACK_COLORS, Button)
    CommandCard.tsx     a saved command shortcut in the same card rect: run / edit / delete
    CommandEditor.tsx   add-edit form + delete confirm; they REPLACE the grid, never overlay it
    Highlight.tsx       one padded line with the fuzzy-matched characters picked out
    ProgressBar.tsx     pct bar used by backup/restore/pull
  screens/
    MainMenu.tsx        utility tiles incl. disabled "coming soon" rows
    Projects.tsx        g:\code card grid: own type-ahead, hover, wheel, click/enter = cd + quit
    Scripts.tsx         fuzzy-filterable flat list of every package script
    ProcessView.tsx     live script output: scrollbox + stickyScroll, spinner, kill
    Backup.tsx          pick db (or presetUrl) → event log + progress → done/error
    Restore.tsx         source (project zip | file path) → target (origin server | localhost existing/new) → run
    LocalDb.tsx         localhost DB browser: list/create/drop + edit connection; launches backup/restore per DB
    Pull.tsx            pick .env db → name local target → dump+restore into localhost, one shot
  lib/
    projects.ts         scan g:\code, stack detect, frecency (own opens + zoxide), matchProject, inspectProject
    fuzzy.ts            fzf-style scorer: subsequence + word-start/camelCase/acronym bonuses, match positions
    commands.ts         saved command shortcuts (config `commands`), load/save/upsert/remove, matchCommand
    text.ts             fit/pad — cell arithmetic every card line goes through
    cd.ts               DESTEDTUI_CD_FILE handoff + the "➜ cd <dir>" line printed after teardown
    config.ts           ~/.destedtui/config.json read/patch (shared by pglocal + projects)
    discovery.ts        walk tree: package.json scripts, .env DATABASE_URLs, PM detection
    pgurl.ts            parse postgres:// URL (PgConn), withDatabase()
    pgtools.ts          server version detect, EDB binary download/cache, adminQuery, adminRows, psql path
    pglocal.ts          localhost conn config (~/.destedtui/config.json), list/create/drop local DBs
    backup.ts           startBackup(): connect → tools → pg_dump -Fc → streamed zip
    restore.ts          listBackupZips(), startRestore(source, target): extract/zip|file → drop/create → pg_restore|psql
    pull.ts             startPull(): dump source → create/overwrite localhost DB → pg_restore, no zip
    run.ts              Bun.spawn wrappers: runScript (line streaming), runTool, treeKill, killAll
    zip.ts              fflate streaming: createBackupZip, readZipMetadata, extractZipEntry
```

## File map (concept → path)

| Concept / task | Location |
| --- | --- |
| Add a new utility screen | `src/screens/`, route in `src/routes.ts`, wire in `src/App.tsx`, tile in `MainMenu.tsx` |
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
- A `.git` folder's own mtime is worthless as "last touched" (any passing `git status` bumps it, so all 221 repos read as "just now"); `.git/logs/HEAD` is the honest signal.

## Status

- **Done** [Project picker](features/project-picker.md) · [Script runner](features/script-runner.md) · [PG backup](features/pg-backup.md) · [PG restore](features/pg-restore.md) — e2e verified against local PostgreSQL 18.3
- **Not built** (menu shows "coming soon"): Git dashboard, Port killer, .env inspector, node_modules nuker
- **Next:** whichever coming-soon tile the user picks
