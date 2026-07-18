# PG Backup

> Status: **done** · Last updated: 2026-07-18

## What / Why

One-keypress Postgres backup for any project with a `DATABASE_URL`. Produces a self-describing zip next to the project's `.env`, using pg_dump binaries that match the server's major version — so pg 9.x through 18.x all dump correctly with zero installed tooling.

## Behavior spec

- Discovery treats any `.env*` file (excluding example/sample/template) containing `DATABASE_URL`, `POSTGRES_URL`, `POSTGRESQL_URL`, or `PG_URL` with a `postgres(ql)://` value as a backup target; the `.env`'s folder is the project folder.
- When the user picks a target (screen shows folder, masked URL, env key), backup runs these steps, each reported as an event line:
  1. Connect via `pg` and `SHOW server_version` (tries SSL relaxed/plain in both orders → works with sslmode=require and local trust).
  2. `ensureTools(major)`: use `~/.destedtui/pg/<major>/bin` if cached; else (Windows) probe `EDB_CANDIDATES` zips newest-first, stream-download with a progress bar, extracting only `pgsql/bin/*`; else fall back to PATH tools if their version ≥ server major.
  3. `pg_dump --format=custom` to a temp file in the project folder (`PGPASSWORD`/`PGSSLMODE` via env, never argv), size polled every 300ms.
  4. Stream-zip to `pgbackup-<db>-<YYYY-MM-DD_HH-mm-ss>.zip`: `<db>.dump` stored + `metadata.json` (db, host, port, serverVersion/Major, tool source, createdAt, dumpBytes) deflated.
- Done state shows db, server version, zip size, and full zip path. Esc during a run cancels (kills pg_dump, temp file deleted).
- pg_dump non-zero exit → error state with the last 8 stderr lines; temp file always cleaned up.

## Touchpoints

| Part | File |
| --- | --- |
| Orchestration | `src/lib/backup.ts` |
| Version detect / tool download | `src/lib/pgtools.ts` |
| Streaming zip | `src/lib/zip.ts` |
| UI | `src/screens/Backup.tsx` |

## Edge cases

- URL-encoded password (`p%40ss`) → decoded before use.
- Server major with no EDB candidate (future pg) → PATH fallback → clear error naming both failures.
- Multi-GB dumps → all streaming, constant memory.
- `--backup` flag jumps straight to this screen.

## How to verify

[heavy — ask first] Full e2e recipe in `verify.md` (downloads ~300MB per new server major, creates scratch DBs).
