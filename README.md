# destedtui

Personal dev-project TUI. `cd` into any project (or monorepo) and run `destedtui` — it scans the tree and gives you keyboard/mouse-driven utilities for whatever it finds. Built with [OpenTUI](https://github.com/anomalyco/opentui) (React bindings) on Bun.

## Utilities

### ▶ Scripts
Finds every `package.json` with scripts in the tree (monorepo-aware, skips `node_modules` etc.), flattens them into one fuzzy-filterable list, and runs the one you pick with the right package manager (detected per package from its lockfile: bun/pnpm/yarn/npm). Live streamed output, spinner, exit status, `ctrl+x` to kill the process tree.

### ⛁ PG Backup
Finds `.env` files containing a `DATABASE_URL` (or `POSTGRES_URL`) pointing at Postgres. Pick one and it:

1. Connects and detects the server version (works with 9.4 → 18, SSL auto-negotiated)
2. Auto-downloads the **version-matched** official `pg_dump`/`pg_restore` binaries (EDB builds) and caches them in `~/.destedtui/pg/<major>` — nothing to install, no version-mismatch corruption
3. Dumps in custom format and writes `pgbackup-<db>-<timestamp>.zip` (dump + metadata.json) next to the `.env`

Everything is streamed — multi-GB databases never touch memory.

### ↺ PG Restore
Pick the project, pick a backup zip (metadata shown: source version, date, size), then choose:

- **Restore to a NEW database** — safe, creates `<db>_restored_<timestamp>`, prints the URL
- **Overwrite** — drops and recreates the original DB; requires typing the database name to confirm

### Coming soon
Git dashboard · Port killer · .env inspector · node_modules nuker

## Install

```bash
git clone https://github.com/dested/destedtui.git
cd destedtui
bun install
bun link
```

Then from any project:

```bash
destedtui            # menu
destedtui --backup   # straight to backup
destedtui --restore  # straight to restore
```

## Notes

- Requires [Bun](https://bun.sh). Windows/macOS/Linux (auto-download of pg tools is Windows; other platforms fall back to `pg_dump` on PATH when its version is ≥ the server's).
- Backups are `pg_dump --format=custom` inside a zip — you can always restore one manually with stock `pg_restore`.
- Restores run with `--no-owner --no-acl --role=<url user>` so they work across machines without the original roles.
