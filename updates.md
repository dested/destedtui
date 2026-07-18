# Updates

> Terse log: what was asked → what was done. Newest first.

## 2026-07-18 — localhost restore target + pull-to-local + local DB browser
Asked: restore into localhost (existing db or a new one), plus cool ideas. Built: (1) Restore now decouples source from target — source can be a project zip OR any file path (.zip/.dump/.backup/.sql), target can be the origin server OR localhost (pick an existing DB to overwrite, or create+name a new one); .sql restored via `psql`, custom archives via `pg_restore`. (2) `Pull to Local` — dumps a .env/remote DB and restores straight into localhost, no intermediate zip (`lib/pull.ts` + `Pull.tsx`). (3) `Local Postgres` browser — list/create/drop local DBs with sizes, edit the saved localhost connection (`~/.destedtui/config.json`), and launch backup/restore per DB (`lib/pglocal.ts` + `LocalDb.tsx`). New menu tiles + `--local`/`--pull` flags. Restore tile no longer needs a DATABASE_URL (file→localhost works). E2E verified vs local PG 18.3 (pull new/overwrite, .sql file restore, list/create/drop). `tsc` clean.
Touched: lib/pgtools.ts (psql path, adminRows), lib/pglocal.ts (new), lib/restore.ts (rewrite), lib/pull.ts (new), screens/Restore.tsx (rewrite), screens/LocalDb.tsx (new), screens/Pull.tsx (new), screens/Backup.tsx (preset), MainMenu.tsx, App.tsx, routes.ts, index.tsx

## 2026-07-18 — create cliffnotes kit
Generated cliffnotes.md, ui.md, decisions.md, verify.md, features/ (script-runner, pg-backup, pg-restore), updates.md.
Touched: docs only

## 2026-07-18 — build destedtui v0.1.0 (initial)
OpenTUI/React/Bun TUI: monorepo script runner + PG backup/restore with auto-downloaded version-matched EDB pg tools; coming-soon tiles for git/ports/env/nuker. E2E verified vs local PostgreSQL 18.3; pushed to github.com/dested/destedtui; globally linked (`destedtui`).
Touched: everything (initial commit)
