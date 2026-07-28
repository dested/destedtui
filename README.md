# destedtui

Personal dev-project TUI. Open a terminal and it hands you your projects; `cd` into one and run `destedtui` for keyboard/mouse-driven utilities over whatever it finds in the tree. Built with [OpenTUI](https://github.com/anomalyco/opentui) (React bindings) on Bun.

## Utilities

### ◈ Projects
A grid of cards, one per folder in your code root, ranked by how often you open it — git branch, how long since you last touched it, and a detected stack badge on each. **Click a card and you're there**: the TUI clears the screen and your shell is now in that directory. Type to filter, `tab` cycles sorting, arrows + `enter` if you'd rather not reach for the mouse. A status line under the grid shows live git state for whatever's highlighted: ahead/behind, uncommitted count, last commit.

Ranking is frecency — your picks, seeded on first run from [zoxide](https://github.com/ajeetdsouza/zoxide)'s existing history if you have it, so the list is useful immediately.

```powershell
destedtui --install-shell   # adds `proj` to your PowerShell profile
```

After that, `proj` (or `pj`) opens the picker anywhere, and it opens **automatically** in any new terminal that starts in your code root — so a fresh tab is a project menu. Set `DESTEDTUI_NO_AUTOSTART=1` to silence it for a session, `DESTEDTUI_PROJECTS_ROOT` to point it somewhere other than `g:\code`.

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

Source can be a project zip or any `.zip`/`.dump`/`.backup`/`.sql` path; target can be the origin server or localhost.

### ⌂ Local Postgres
Browse localhost databases with sizes and owners — create, drop, back up, or restore into any of them. The connection is a single saved preset in `~/.destedtui/config.json`.

### ⇩ Pull to Local
Dump a remote/`.env` database and restore it straight into localhost in one shot, no intermediate zip.

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
destedtui --projects # project picker (also: proj)
destedtui --backup   # straight to backup
destedtui --restore  # straight to restore
destedtui --local    # localhost database browser
destedtui --pull     # clone a database into localhost
```

## Notes

- Requires [Bun](https://bun.sh). Windows/macOS/Linux (auto-download of pg tools is Windows; other platforms fall back to `pg_dump` on PATH when its version is ≥ the server's).
- Backups are `pg_dump --format=custom` inside a zip — you can always restore one manually with stock `pg_restore`.
- Restores run with `--no-owner --no-acl --role=<url user>` so they work across machines without the original roles.
