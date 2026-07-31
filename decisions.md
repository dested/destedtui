# Decisions

> Append-only. A recorded decision is settled unless the user reopens it.

## 2026-07-30 — Command shortcuts run where the shell already is
**Why:** user's call — "`cc` should run `bunx ccusage` in whatever dir i was in". So a shortcut is a *tool*, not a project action: `runHere` hands back `cwd` as the directory (a no-op `Set-Location`) plus the command, and records no frecency, because you didn't open a project. They live in `~/.destedtui/config.json` under `commands`, are edited in-app (`ctrl+n`/`ctrl+e`/`ctrl+x`), and share the project grid so there's only one caret and one set of keys to drive.
**Rejected:** cd-ing to the highlighted project first (that's what the card buttons already are); a per-command `scope` flag (asked, and the answer was "current directory" — add it only if a real case shows up); hand-editing config.json as the only way in (a shortcut you can't add without an editor doesn't get added); a `--add-cmd` CLI flag (same problem, one indirection worse).

## 2026-07-30 — The filter is an fzf-style scorer, with an acronym bonus on top
**Why:** "frop should match frozen-ropes", plus camelCase search. The old four-tier `score()` (exact > word-start > substring > subsequence) couldn't express "these letters landed on word starts", which is the whole signal. `lib/fuzzy.ts` runs fzf's V2 recurrence (two tables so gaps cost something and the match can be walked back out for highlighting), then adds **+10 per character when every match landed on a word start or camelCase hump** — without that, gap penalties sink `sps` in `sals-powershell-setup` below `sps` in `slopshow`, which is backwards. Trailing text is free so long names aren't punished, which keeps frecency as the tiebreak the picker is built around. Exact (+1000) and prefix (+400) bumps sit on top so muscle memory still wins.
**Rejected:** a fuzzy library (this is 120 lines with no dependency, and the bonuses need to be tunable per this list's shape); scoring the description too (a long sentence matches almost any subsequence — noise); keeping the old tiers and adding a fifth (the tiers are what threw the information away).

## 2026-07-28 — The profile block goes at the TOP, and the profile timer lies
**Why:** user reported "takes like 5 seconds to start, and i can't do anything until it's done", with PowerShell reporting a 6056ms profile load. Measured: launch → first frame is ~400ms (bun ~280 + opentui import 111 + scan 47 + renderer 10), and the profile alone is ~430ms warm. The 6s is PowerShell's timer still running while the picker waits for a click — it runs *inside* profile loading. Real fix: `install.ps1` now inserts the block immediately after any `using` statements instead of appending, so the picker paints before the profile's oh-my-posh/PSReadLine/module work rather than after it, and that work happens once you've picked.
**Rejected:** deferring the launch to `PowerShell.OnIdle` like the profile's module loading (that fires while PSReadLine owns the console — a full-screen TUI would fight it for the terminal, and `Set-Location` from an event action isn't reliably the session's); `bun build --compile` to shave the ~280ms bun start (a build step on every edit, for a tool that's edited constantly).

## 2026-07-28 — Card buttons run their command in YOUR shell, not inside the TUI
**Why:** user asked for a `dev` button and a claude button (`claude --dangerously-skip-permissions`) inside each card. Both need a real interactive terminal — claude especially. So the handoff file grew a second line: line 1 is the directory, line 2 an optional command, and `proj` does `Set-Location` then `Invoke-Expression`. destedtui exits before anything runs, so the command owns the terminal completely. The dev command is derived per project (`<pm> run dev|start|serve`, pm from the lockfile) and the button is absent when there's no script.
**Rejected:** running the command inside destedtui via `runScript`/ProcessView (a nested pty for an interactive agent — no); hardcoding `bun dev` (wrong for the pnpm/yarn projects); a fixed command list in config (per-project detection is free).

## 2026-07-28 — The picker is a card grid, and one click goes
**Why:** user's call after seeing the list version — "bigger. cards, not list. i want to click and i want to click fast". So: a reflowing grid of 5-row cards (5 columns at 170 wide, 3 at 92), hover to highlight, **single click acts immediately** — no select-then-confirm, since a `cd` is cheap and reversible. Picking clears the screen and scrollback so you land on a clean terminal with one `➜ cd …` line.
**Rejected:** list rows (what this replaced); double-click or click-then-enter (slow, and there's nothing to protect against); a detail pane (the card carries the info; live git is one status line under the grid).

## 2026-07-28 — The picker `cd`s via a temp file handed in by the shell wrapper
**Why:** a child process can't change its parent's directory, and this feature is worthless if it can't. `proj` sets `DESTEDTUI_CD_FILE`, the TUI writes the chosen path there and exits, the wrapper `Set-Location`s. Without the wrapper the TUI just prints the path and points at `--install-shell`, so nothing silently does nothing.
**Rejected:** printing a path for the user to paste (defeats the point); `eval $(destedtui)` shell-eval (fragile quoting on Windows, and the TUI needs the terminal for its own rendering); a resident daemon.

## 2026-07-28 — Ranking is our own opens **plus** zoxide's score
**Why:** a frecency list that starts empty is alphabetical noise for weeks. zoxide is already installed and has years of `cd` history, so `zoxide query --list --score` seeds day-one ordering (sub-paths fold into their project), and our own `projectOpens` reinforce it from there. Missing zoxide degrades to own-opens-only, never an error.
**Rejected:** own counts only (cold start); zoxide only (can't reward picks made *in* the picker); mtime ordering (measures builds, not attention).

## 2026-07-28 — Auto-launch only when the shell **started** in the projects root
**Why:** the user wants a project menu when they open a terminal, not a modal ambush every time a script spawns a shell. `Test-DestedTuiAutostart` additionally requires an interactive ConsoleHost with no `-Command`/`-File` and no `CLAUDECODE`/`CI`. A shell opened inside a project means you already know where you're going, so it stays quiet.
**Rejected:** launching on every interactive shell; a `wt` profile that runs the picker as its command (breaks the shell that has to receive the `cd`).

## 2026-07-28 — The install block goes in the real profile, marked and idempotent
**Why:** `$PROFILE` here is a shim that dot-sources `sals-powershell-setup`'s copy; writing to the shim would be erased by that repo's own installer. `shell/install.ps1` follows symlink/shim to the real file, appends a `#region destedtui` block (append on first install, rewrite only on refresh so a 1800-line hand-maintained profile is never round-tripped), and `-Uninstall` removes it.
**Rejected:** editing the shim; a copy of the integration into the profile (drifts); telling the user to paste it themselves.

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
