# destedtui — CliffNotes

> Living map of the project. Read this before any coding session.
> Last updated: 2026-07-18.

## What this is

Personal dev-project TUI for dested. `cd` into any project and run `destedtui` — it scans the tree and offers utilities: a monorepo-aware package.json script runner and Postgres backup/restore driven by `.env` `DATABASE_URL`s. The unusual part: pg client tools are auto-downloaded per server major version (EDB builds) so dumps are never version-mismatched.

## Quick Reference

- **Run:** `bun run dev` in this repo, or `destedtui` anywhere (globally linked via `bun link`)
- **Entry point:** `src/index.tsx` → arg parsing → `createCliRenderer` → `<App/>`
- **Type-check:** `bun x tsc --noEmit`
- **Test:** no test runner — see `verify.md` for smoke/e2e scripts
- **CLI flags:** `--backup`, `--restore` (jump straight to a screen), `--help`, `--version`
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
src/
  index.tsx             CLI entry: --help/--version/--backup/--restore, renderer boot
  App.tsx               Route stack (push/pop), discovery kickoff, global ctrl+c quit
  routes.ts             Route union type
  theme.ts              T = Tokyo Night palette + SPINNER_FRAMES (single source of color truth)
  components/
    Header.tsx          ascii-font "DESTED" gradient header + cwd
    Footer.tsx          keybind hint bar (Hint = [key, label])
    ListPicker.tsx      THE list primitive: windowed, keyboard+mouse, badges, disabled rows
    ProgressBar.tsx     pct bar used by backup/restore
  screens/
    MainMenu.tsx        utility tiles incl. disabled "coming soon" rows
    Scripts.tsx         fuzzy-filterable flat list of every package script
    ProcessView.tsx     live script output: scrollbox + stickyScroll, spinner, kill
    Backup.tsx          pick db → event log + progress → done/error
    Restore.tsx         pickdb → pickzip → pickmode → confirm (type db name) → run
  lib/
    discovery.ts        walk tree: package.json scripts, .env DATABASE_URLs, PM detection
    pgurl.ts            parse postgres:// URL (PgConn), withDatabase()
    pgtools.ts          server version detect, EDB binary download/cache, adminQuery
    backup.ts           startBackup(): connect → tools → pg_dump -Fc → streamed zip
    restore.ts          listBackupZips(), startRestore(): extract → drop/create → pg_restore
    run.ts              Bun.spawn wrappers: runScript (line streaming), runTool, treeKill, killAll
    zip.ts              fflate streaming: createBackupZip, readZipMetadata, extractZipEntry
```

## File map (concept → path)

| Concept / task | Location |
| --- | --- |
| Add a new utility screen | `src/screens/`, route in `src/routes.ts`, wire in `src/App.tsx`, tile in `MainMenu.tsx` |
| Colors / look | `src/theme.ts` (+ `ui.md`) |
| What gets discovered in a project | `src/lib/discovery.ts` (SKIP_DIRS, DB_URL_KEYS, maxDepth=4) |
| Supported pg versions / download URLs | `src/lib/pgtools.ts` → `EDB_CANDIDATES`, `MAJOR_ORDER` |
| Backup zip name/contents | `src/lib/backup.ts` (`pgbackup-<db>-<ts>.zip`, `<db>.dump` + `metadata.json`) |
| Restore safety (drop/confirm) | `src/lib/restore.ts` + confirm UI in `src/screens/Restore.tsx` |
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

## Gotchas & hard rules

- **useKeyboard fires globally** for every mounted component — only mount one screen at a time, and beware double-handling enter: an `<input onSubmit>` and a `useKeyboard("return")` both fire on the same keypress (already bitten twice; pick one owner per screen).
- **ListPicker `vimKeys` must stay off** on any screen with a text input (j/k would collide with typing).
- **Never buffer a dump in memory** — dumps can be multi-GB; all zip paths go through the streaming helpers in `lib/zip.ts`.
- pg_dump/pg_restore version must be ≥ server major (restore wants ==); that's what `EDB_CANDIDATES` + `ensureTools` guarantee. New pg major released → add candidates to both `EDB_CANDIDATES` and `MAJOR_ORDER`.
- `exitOnCtrlC: false` in the renderer — ctrl+c is handled in `App` (kills children via `killAll()` first). Don't re-enable.
- Windows script execution goes through `cmd.exe /d /s /c`, and kills via `taskkill /T /F` (plain `.kill()` orphans grandchildren).
- Literal ESC bytes in source files break this harness's edit tools — `ANSI_RE` in run.ts is built with `String.fromCharCode(0x1b)` on purpose.
- Restore runs `--no-owner --no-acl --role=<url user>` (deliberate — see decisions.md).

## Status

- **Done** [Script runner](features/script-runner.md) · [PG backup](features/pg-backup.md) · [PG restore](features/pg-restore.md) — e2e verified against local PostgreSQL 18.3
- **Not built** (menu shows "coming soon"): Git dashboard, Port killer, .env inspector, node_modules nuker
- **Next:** whichever coming-soon tile the user picks
