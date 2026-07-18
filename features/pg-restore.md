# PG Restore

> Status: **done** · Last updated: 2026-07-18

## What / Why

Restores a destedtui backup zip into the project's Postgres server — either safely side-by-side or over the original after an explicit typed confirmation. The destructive path is deliberately the harder one.

## Behavior spec

- Flow: pick project (same discovery list as backup) → pick zip → pick mode → (overwrite only) confirm → run.
- Zip list = `pgbackup-*.zip` in the project folder, newest first, each showing size, source server version (from metadata.json, read via streaming without loading the zip), and mtime. Empty → "run a backup first" hint.
- Mode list (safe option first):
  - **New database**: creates `<db>_restored_<yyyymmdd_hhmm>` and restores there; done screen prints the masked connection URL. Original untouched.
  - **Overwrite**: requires typing the exact database name into an input (border turns green on match, enter enabled); then terminates backends, `DROP DATABASE IF EXISTS`, `CREATE DATABASE`, restores.
- Restore = extract `.dump` from zip (streamed) → `pg_restore --no-owner --no-acl --role=<url user>` with version-matched tools (same `ensureTools` as backup). Admin queries go to the `postgres` maintenance DB, falling back to `template1`.
- If backup's major ≠ target server's major, a note event is shown (not a block).
- pg_restore non-zero exit → treated as "finished with warnings" (its exit 1 covers ignorable errors): done state + last 15 stderr lines. Hard failures before pg_restore (connect, extract, admin SQL) → error state.
- Esc cancels a running restore (kills pg_restore) and steps back one sub-phase from any picker.
- `--restore` flag jumps straight to this screen.

## Touchpoints

| Part | File |
| --- | --- |
| Orchestration + zip listing | `src/lib/restore.ts` |
| Admin SQL / tools | `src/lib/pgtools.ts` |
| Streaming extract | `src/lib/zip.ts` |
| UI incl. typed confirm | `src/screens/Restore.tsx` |

## Edge cases

- Zip without a `.dump` entry → explicit "is it a destedtui backup?" error.
- Db names quoted with `""`-escaping in DDL; terminate-backends uses `''`-escaped literal.
- Overwrite of a DB with live connections → backends terminated first, so drop succeeds.

## Open questions

- [ ] Cross-major restore (e.g. pg16 dump → pg14 server) is warned about but not blocked — acceptable for personal use; revisit if it ever bites.

## How to verify

[heavy — ask first] Both modes covered by the e2e recipe in `verify.md`.
