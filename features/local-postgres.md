# Local Postgres

> Status: **done** · Last updated: 2026-07-18

## What / Why

A tiny admin browser for the **localhost** Postgres server — independent of any project `.env`. See every database with its size and owner, create/drop them, edit the saved connection, and jump straight into a backup or restore for a chosen DB. This is the home base for "I have a dump, put it in my local DB."

## Behavior spec

- **Connection**: loaded from `~/.destedtui/config.json` → `localhost`, defaulting to `PG*` env vars then `postgres:postgres@localhost:5432` (`lib/pglocal.ts`). Edited on-screen (`e`) as a single `postgres://…` URL; empty enter keeps current; saved back to the config file. A connect failure shows the error and offers the editor (enter).
- **List** (`list`): `listLocalDatabases` = non-template DBs ordered by size desc, each row `name · owner · encoding` + size badge. Keys: `enter` = actions, `c` = create, `e` = edit connection, `r` = refresh, `esc` = back.
- **Create** (`c`): name input → `CREATE DATABASE` → refresh.
- **Per-DB actions** (`dbmenu`): **Back up to zip** (→ Backup screen with `presetUrl`, zip lands in cwd), **Restore a backup/file into it** (→ Restore screen with a fixed localhost `preset` target, overwrite), **Drop database** (typed-name confirm → terminate backends + `DROP DATABASE IF EXISTS` → refresh).
- `--local` jumps straight here. Returning from a launched backup/restore remounts the screen (re-lists).

## Touchpoints

| Part | File |
| --- | --- |
| Conn config, list/create/drop | `src/lib/pglocal.ts` |
| Row-returning admin query | `src/lib/pgtools.ts` (`adminRows`) |
| UI | `src/screens/LocalDb.tsx` |
| Backup/Restore presets | `Backup.tsx` (`presetUrl`), `Restore.tsx` (`preset`), routes in `routes.ts` |

## Edge cases

- `pg_database_size` requires connect priv on each DB — fine as the superuser this tool assumes locally; a permission error surfaces as a connect error with the editor offered.
- Drop terminates other backends first so it doesn't hang on active sessions.

## Open questions

- [ ] Table count per DB isn't shown (would cost a connect per DB). Size + owner only for now.
- [ ] No rename (Postgres `ALTER DATABASE … RENAME` needs no active connections); skipped until wanted.

## How to verify

[heavy — ask first] `listLocalDatabases`/create/drop exercised by the smoke test in `verify.md`. Browser UI driven manually.
