# Decisions

> Append-only. A recorded decision is settled unless the user reopens it.

## 2026-07-18 — Restore target is decoupled from the backup's origin
**Why:** user asked to restore into localhost regardless of where the dump came from. `startRestore(source, target)` now takes an explicit target connection + mode; source is a project zip OR a raw file. Target options: origin server (`.env`) or localhost (existing DB → overwrite w/ typed confirm, or a new DB you name). Restore no longer requires a discovered DATABASE_URL — a file → localhost path exists.
**Rejected:** keeping restore welded to the `.env` server (the original design); a separate "restore to localhost" screen (would duplicate source-picking).

## 2026-07-18 — Localhost connection is a single saved preset, edited as a URL
**Why:** localhost features need creds the `.env` doesn't carry. Stored at `~/.destedtui/config.json` under `localhost`, defaulting to `PG*` env vars then `postgres:postgres@localhost:5432`. Edited via one `postgres://…` URL input (empty enter = keep current) — one field beats a 4-field focus-juggling form in a TUI.
**Rejected:** per-run credential prompts; a multi-field connection form.

## 2026-07-18 — `.sql` dumps restore via psql; custom archives via pg_restore
**Why:** "restore any file" must handle plain-text `.sql` too. `dumpKind()` routes `.sql` → `psql -f` and everything else (`.dump/.backup`, or the entry inside a zip) → `pg_restore`. psql/pg_restore both come from the cached EDB bin. Restore temp files go to the OS temp dir, not the project folder (target may be unrelated to cwd).
**Rejected:** custom-format only; shelling to a system psql (may be absent/mismatched).

## 2026-07-18 — Pull-to-local skips the zip
**Why:** the daily "clone prod into local" path shouldn't leave a zip to manage. `startPull` dumps the source to an OS-temp custom archive and pg_restores it straight into the localhost target (create or drop+recreate), then deletes the temp. Source dumped with source-major tools, restored with target-major tools so cross-version pulls work.
**Rejected:** reusing backup-zip + restore (extra artifact + two manual steps).

## 2026-07-18 — Auto-download EDB pg binaries per server major
**Why:** pg_dump must be ≥ (ideally ==) the server's major; user has 9/10-era servers. Downloading official EDB Windows zips (streamed, only `pgsql/bin/*` kept, cached in `~/.destedtui/pg/<major>`) makes backups version-correct with zero setup.
**Rejected:** PATH pg_dump only (breaks on version mismatch — kept as fallback), pure-JS dump via `pg` (misses sequences/types/extensions; not bulletproof).

## 2026-07-18 — One repo, one bin (`destedtui`), backup lives inside
**Why:** user's call — originally a separate `backup-pg` CLI was planned; folded into destedtui with `--backup`/`--restore` flags instead.
**Rejected:** separate backup-pg repo/bin.

## 2026-07-18 — Restore offers both modes, asks every time
**Why:** user's call. "New DB" (`<db>_restored_<ts>`) is the safe default listed first; overwrite requires typing the db name. Overwrite = terminate backends → DROP → CREATE → pg_restore.
**Rejected:** overwrite-only, new-db-only.

## 2026-07-18 — Restores run `--no-owner --no-acl --role=<url user>`
**Why:** personal-tool bulletproofing — restores must work on machines where the original roles don't exist; objects end up owned by the connecting user.
**Rejected:** faithful owner/ACL restore (fails on missing roles for zero benefit in solo dev use).

## 2026-07-18 — fflate streaming for all zip I/O; dump entry stored not deflated
**Why:** dumps can be multi-GB — nothing may buffer them. `pg_dump -Fc` is already zlib-compressed, so the zip entry uses `ZipPassThrough` (store); only metadata.json is deflated.
**Rejected:** adm-zip / in-memory `unzipSync` (memory blowup), skipping zip entirely (user asked for zip).

## 2026-07-18 — Custom `ListPicker` instead of opentui `<select>`
**Why:** full control of look (badges, disabled coming-soon rows, subtitle dimming, windowing) + uniform mouse-click behavior across screens.
**Rejected:** opentui `<select>` (styling too constrained).
