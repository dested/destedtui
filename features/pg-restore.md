# PG Restore

> Status: **done** · Last updated: 2026-07-18 (localhost target + file source)

## What / Why

Restores a dump into a Postgres database of your choosing. The **source** (where the dump is) and the **target** (where it lands) are independent: restore a project backup back onto its origin server, or drop any dump into your localhost server — into an existing DB (overwrite) or a fresh one you name. The destructive paths always require typing the DB name.

## Behavior spec

- **Source pick** (`pickproject`): the discovery DB list *plus* a "Restore from a file…" row. Picking a project → `pickzip` (its `pgbackup-*.zip`, newest first, size + source version from streamed metadata.json). Picking "from a file" (or no `.env` DBs found at all) → `pickfile`, a path input accepting `.zip` / `.dump` / `.backup` / `.sql`.
- **Target pick** (`picktarget`, only when the source is a project zip — it has an origin): **Original server** (the `.env` server) or **Localhost Postgres**. A file source skips straight to localhost.
  - **Original server** → `pickmode`: New DB (`<db>_restored_<ts>`, safe, listed first) or Overwrite (typed confirm). Unchanged from the original behavior.
  - **Localhost** → `connectlocal` (lists local DBs w/ sizes) → `picklocaldb`: "＋ Create a new database" (name it → create+restore) or an existing DB (typed-name confirm → drop+recreate → restore).
- **Run** = resolve artifact (extract `.dump/.sql` from a zip, streamed, or use the file directly) → create/overwrite the target DB (`adminQuery` on the `postgres` maintenance DB, `template1` fallback) → restore. Custom archives → `pg_restore --no-owner --no-acl`; plain `.sql` → `psql -f --set=ON_ERROR_STOP=0`. Tools are the target server's major via `ensureTools`. Temp extract goes to the OS temp dir.
- Target detection tries the maintenance DB first, so a not-yet-created target still resolves the server version. Version-mismatch (backup major ≠ target major) → note event, not a block.
- `pg_restore`/`psql` non-zero exit → "finished with warnings" done state + last 15 stderr lines. Hard failures earlier (connect, extract, admin SQL) → error state; a local-connect failure points the user at the Local Postgres screen to fix creds.
- **Preset target** (`preset` prop, set when launched from the Local Postgres browser): target DB is fixed to that local DB (mode `overwrite`); flow is just source-pick → typed confirm → run.
- Esc steps back one sub-phase; `--restore` jumps here.

## Touchpoints

| Part | File |
| --- | --- |
| Orchestration (source→target), zip listing | `src/lib/restore.ts` |
| Admin SQL / row queries / tools / psql path | `src/lib/pgtools.ts` |
| Localhost conn + DB list | `src/lib/pglocal.ts` |
| Streaming extract | `src/lib/zip.ts` |
| UI: source/target pickers + typed confirms | `src/screens/Restore.tsx` |

## Edge cases

- Zip without a `.dump/.backup/.sql` entry → explicit error.
- New local DB name that already exists → blocked in the input ("pick it from the list to overwrite").
- Db names quoted with `""`-escaping in DDL; terminate-backends uses `''`-escaped literal.
- Overwrite of a DB with live connections → backends terminated first, so drop succeeds.

## Open questions

- [ ] Cross-major restore (e.g. pg16 dump → pg14 server) is warned about but not blocked — acceptable for personal use; revisit if it ever bites.
- [ ] `restore into an existing DB` always drops+recreates (clean slate). A `--clean`/merge-into-existing mode isn't offered; add if a real need appears.

## How to verify

[heavy — ask first] Lib layer covered by the smoke test in `verify.md` (pull + `.sql` file restore + overwrite vs live PG 18.3). TUI flow driven manually — no PTY in CI.
