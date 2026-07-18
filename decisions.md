# Decisions

> Append-only. A recorded decision is settled unless the user reopens it.

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
