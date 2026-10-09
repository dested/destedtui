# Decisions

> Append-only. A recorded decision is settled unless the user reopens it.

## 2026-10-08 — bx monitor: a destedtui screen over the daemon's own /debug, judged on private commit
Sal's call: the TUI goes here, and the endpoint goes in bx. Mine: the screen merges two sources. One is bx's `GET /debug`, for what only the daemon knows (journal, drivers, per-tab CDP metrics, internal sizes). The other is the `lib/ports.ts` process scan, for the whole node → Chrome tree, which /debug can't see. The leak number is private commit with a 5-min least-squares slope, not working set, and history stays in memory for 30 min, with an opt-in JSONL memlog.
**Rejected:**
- A `bx top` verb in bx. bx stays the automation tool, and the tree scanner and session labels already live here.
- Working set as the default metric. It hid the 68 GB incident behind a 2.8 GB working set.
- Talking CDP to each Chrome from the TUI. Playwright drives Chrome over a pipe, so there's no debugging port to reach. /debug proxies the metrics, with an 800ms timeout per tab.
- Persisting history by default. The memlog is one toggle away.

## 2026-10-04 — Claude usage: native transcript parser, API-equivalent dollars, priced at view time
Sal's calls: build it natively (no repo of his existed — only the `cc` → `bunx ccusage` shortcut), label dollars API-equiv, roll sessions up to the top-level g:\code folder, all four views. Mine:
- **Own parser over shelling out to ccusage.** ccusage re-reads all ~18 GB each run (~1 min) and groups by exact cwd; an incremental cache by byte offset makes reopening instant and lets project, active time and timeline be ours.
- **The cache stores tokens, never dollars**, so a price fix reprices history with no rescan. Prices live in one table in `pricing.ts`, verified against Claude Code's `cost-state` lines rather than LiteLLM's feed (which lags new models).
- **Transcripts that vanish keep their cache entry** — Claude Code deletes old transcripts, and the cache is then the only record.
- **Active time = event minutes with ≤5-minute gaps, unioned across sessions.** Wall-clock first→last overstates a session left open overnight; summing sessions double-counts parallel agents.
- **Rejected:** summarize in the Worker (the structured-clone round trip costs what it saves); per-day aggregates in the cache (range filtering and re-pricing need per-message data, and 260k tuples is only ~16 MB).

## 2026-10-04 — Keys rotate + Drydock: the builder's calls
Sal's: a rotate screen (`R` / `keys rotate`) — overview, a confirmed step-by-step walk (create → .env → Drydock push + redeploy → verify), resumable from the vault, revoke only after every new-key project is verified, console fallback naming the key; batch revoke of dead shared keys, blocked on "deployed, value unknown" until overridden; `keys push`; `[dd]` markers; apps mapped by repo, then name, then a manual override. Mine:
- **The override wins over repo/name matching** (the spec listed it last). A manual pin is a correction; letting an automatic match beat it would make it useless. `-` pins an app to "not a local project".
- **Env values are read, fingerprinted and dropped inside `drydock.ts`.** The portal returns decrypted SSM values; nothing outside that module (cache, CLI, screen) ever holds one. The cache is var → fingerprint, like every other surface.
- **"Deployed" for the plan = the folder has a Drydock app at all; "deployed" for dead = an app holds (or might hold) this value.** A project whose app demonstrably runs a different key still gets a new key by default (Sal said active or deployed), but doesn't keep a dead key alive.
- **Folders whose app holds the value join the rotation even if their `.env` doesn't**; apps holding it with no mapped folder block the revoke. Revoking out from under a production app is the one failure this flow exists to prevent.
- **The project's old record is retired locally at create time (`replaceLocalOnly`), the remote revoke waits for the finish.** Without it, the last `--replace` in a walk would revoke the shared key remotely before anything was verified.
- **The finish re-reads Drydock and refuses on a portal that's down** — a 15-minute-old cache can't green-light a revoke.
- **A project that already has its own non-shared key for the provider keeps it** (create step = "use its own") instead of being re-minted.
- **Activity = newest of the last Claude prompt and the last reflog commit**, read from files (no `git` per folder; a TUI frame can't wait on 80 spawns). The 30-day line is Sal's. It makes Sal's agent clones (`mmo-*`) "active", so the ElevenLabs key lands at 24 new / 0 cut off; toggle them in the overview.
- **Verify skips providers with no cheap check (fal, custom) as "unverified", not failed** — otherwise the walk could never finish for them.
- **Console revokes name the key by its `keys-<project>` name when minted, else its last 4 characters** (Sal asked for "name or last 4"; consoles show the same tail).
- **`--simulate` exists next to `--dry-run`**: dry-run prints and exits (for Claude and for review), simulate is the screen with every step a dry run, so the walk can be seen and captured without touching a real project.

## 2026-10-04 — Keys usage: owners, a 15-minute cache, and estimates labelled as estimates
Sal's calls: a Usage view on the Keys screen + `keys usage`, nothing in the brief; per project today / 7d / 24h / sparkline, $ where reported, raw units otherwise, hottest first; cache in `~/.destedtui/keys/usage.json` refreshed ~15 min or on demand; build Anthropic against an Admin key he'll add. Mine:
- **Lines are owners, not keys.** A value live in N projects lands on one `⚠ shared × N` line and is never credited to a project — splitting it would invent numbers, and the shared line is exactly the thing to untangle. Unknown provider keys and no-key usage get their own lines instead of vanishing, so the total is honest.
- **24h is an estimate** (today + the overlapping fraction of yesterday): every provider buckets $ by UTC day; OpenAI's costs endpoint only has `1d`. Labelled `24h≈` everywhere. Rejected: hourly token usage × a derived rate (per-model rates, more calls, still an estimate).
- **Anthropic $ per key is allocated**: the cost report can't group by key, so each (day, model, token type) cost is split by that key's token share; non-token costs stay on the account line. Marked "allocated". Rejected: tokens only (Sal wants $), a hard-coded price table (goes stale).
- **ElevenLabs uses the workspace analytics endpoint and matches by key name**: `character-stats` per-key came back empty, while `usage-by-product-over-time` grouped by `hashed_xi_api_key` returns per-key $ and credits. The hash isn't any plain digest of the key, so the name is the only join; unmatched keys show under their name. Minted keys are named `keys-<project>-<label>`, so they always match.
- **OpenAI matches by redacted value** (prefix + last 4), refusing ambiguous matches; deleted keys (openai-image's ephemeral ones, mostly) group as one "deleted keys" line.
- **OpenRouter's numbers are windows** (today, week to date) from `GET /api/v1/key` called with each key — no admin needed, but no day series, so no sparkline; its unnamed-key label is its own redacted value and is dropped before caching.
- **The cache is plain JSON**, not DPAPI: it holds no secrets (provider key ids/names, vault key ids, numbers), and plain JSON can be inspected and deleted freely.

## 2026-10-03 — Keys vault: builder's calls made overnight (Sal asleep — eyeball these)
The settled parts (DPAPI vault, `keys` bin, mint-where-possible, `.env` distribution) are Sal's, in `plans/2026-10-03-keys.md`. These are mine:
- **`new` and `add` write the project's `.env` immediately** (`--no-env` opts out). The goal is "the key ends up in the .env"; a separate `keys env` step is one more thing for a Claude session to forget. `keys env` stays for re-syncs.
- **`--project` defaults to the cwd's project folder** (first segment under the projects root). Projects are matched case-insensitively and must exist as folders, or be `shared`.
- **Remote revoke is skipped when another project still holds the same value.** Almost every imported key is shared (one ElevenLabs key is in 24 projects); revoking it remotely to clean up one project would break 23 others. Local mark + a printed reason instead.
- **`--replace` rotates**: refuses a second key for (provider, project) without it. A mint that can't be stored is revoked again immediately.
- **Import keeps one key per (project, provider)**: the shallowest plain `.env` wins; a different value elsewhere in the same project is reported as a conflict, not stored. Each key remembers its `envFile` and var name (`web/.env`, `VITE_OPENAI_API_KEY`) so `keys env` writes it back where the app reads it. Gemini is matched by var name only — `AIza` is every Google API key, Maps included.
- **Admin credentials fall back to the adapter's user env var** (`OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`) when the vault has none — the openai-image skill already relies on `OPENAI_ADMIN_KEY`. `keys admin set <p> --from-env VAR` copies one into the vault; I did **not** run it for OpenAI (the session's permission layer blocked writing the admin key into a secret store), so minting reads the env var today.
- **OpenAI keys are project service accounts in an existing OpenAI project** (meta `projectId` → one named like the Sal project → "Default project"), not a new OpenAI project per Sal project: OpenAI projects can be archived but never deleted, so auto-creating them would litter the org.
- **`reveal` and `values` refuse when `CLAUDECODE` is set**, on top of `--yes-print-secret`. `values` (JSON on stdout) exists only for PowerShell's `Use-Keys`.
- **Clipboard and DPAPI go through bun:ffi** (crypt32/user32/kernel32), like `lib/ports.ts` — no pwsh boot, and the secret never crosses a process pipe.
- **The profile's `keys` alias for the cheatsheet became `cheat`** (sals-powershell-setup): aliases outrank executables, so the alias would have shadowed the bin. F1 is unchanged.
- **Screen accent is orange** (shared with restore; never on screen together), and its list is a custom table like the localhost screen, not `ListPicker`, because rows need their own buttons and group headers that navigation skips.
**Rejected:** a master password (Sal's call: DPAPI only); printing values for convenience in any mode a Claude session can reach; auto-creating OpenAI projects; letting import store two keys for one provider in one project.

## 2026-10-03 — Localhost scanner reads Win32 through bun:ffi, not netstat/PowerShell
**Why:** the screen polls (servers come and go while you watch) and needs what no single command gives: listening ports + owning pid, the parent chain, and each process's **working directory** — which Windows only exposes inside the process's own PEB. `Get-CimInstance Win32_Process` + `Get-NetTCPConnection` costs a pwsh boot (~0.5–1s) per poll and still has no cwd. So `lib/ports.ts` calls `GetExtendedTcpTable` (v4+v6 listeners), `CreateToolhelp32Snapshot` (pid/ppid/exe) and `NtQueryInformationProcess` + `ReadProcessMemory` (cmdline + cwd from the PEB) directly. Full scan ≈35ms, zero subprocesses; cmdline/cwd cached per pid+start-time.
**Kill = the dev-command chain, not just the listener.** Killing only `node vite` lets a watcher (`bun --watch`, nodemon, next) respawn it and leaves `bun run dev` holding the terminal. `x` climbs parents while they're node/bun/`cmd /c` and stops before this tui's ancestry, any shell, or a claude process; the UI states the exact target and every other port in that tree before the second press. `shift+x` is the listener-only escape hatch.
**Rejected:** netstat parsing + PowerShell for details (slow, no cwd); a native addon (build step for one feature); listener-only kill as the default (respawns); a confirm modal (a second press with the target spelled out is enough for a dev server).

## 2026-08-06 — sal-review absorbed into destedtui; standalone repo retired
**Why:** the review CLI wanted a real TUI (scope picker, streaming activity, verdict screen) and destedtui already owns the opentui stack, theme, and global-bin plumbing — two repos meant two link targets and a duplicated visual language. `review` is now a second bin in this package (`src/review.tsx`) deep-linking to a Review screen; the engine lives in `src/lib/review*.ts` + `prompts/`. The reviewer stays a **fresh headless `claude-opus-4-8 --effort high`** process (clean context is the whole point) and stays read-only via `prompts/reviewer-settings.json` (dontAsk + allowlist). Windows constraint carried over: the prompt goes over **stdin** and argv stays simple tokens (claude is a `.cmd` shim; JSON/parens on the command line get mangled), and template substitution uses **function replacers** (`$&`-class tokens in dynamic text silently corrupt string replacements). `G:\code\sal-review` deleted after the move.
**Rejected:** keeping sal-review as its own repo (duplicate stack for one screen); porting the reviewer into-process (would inherit this session's context — disqualifying).

## 2026-08-06 — Review ledger dropped: every review is fresh
**Why:** user's call during the port. sal-review kept `.sal-review/` (ledger.jsonl + last-review.md) in target repos to track still-open findings across runs; in practice it dirtied target repos and the carry-over prompt section bought little. No files are written to reviewed repos anymore, and the prompt/output contract lost `previousFindings` entirely.
**Rejected:** keeping the ledger as-is; an opt-in `--ledger` flag (dead weight).

## 2026-08-01 — Terminal wheel-scroll is context-aware, and notes persist by title
**Wheel scroll:** the terminal pane had no wheel handling at all (`TerminalView` always rendered from `baseY`, i.e. pinned to the bottom). A single behaviour is wrong because what "scroll" means depends on what's on screen, so the renderable's scroll listener branches: (a) if the app has enabled mouse tracking (`xterm modes.mouseTrackingMode !== "none"` — claude, htop, vim), forward an **SGR wheel event** (`ESC[<64/65;col;rowM`) so the app scrolls its *own* viewport; (b) else if we're on the **alternate** buffer (a pager like `less`/`man` that didn't ask for the mouse), send arrow up/down (respecting `applicationCursorKeysMode`); (c) else it's a plain shell, so scroll our **own xterm scrollback** via `scrollLines` and render from `viewportY` instead of `baseY`. The block cursor is compared in absolute buffer coords and hidden while scrolled off the bottom. We emit SGR (1006) unconditionally in case (a) because xterm-headless exposes the tracking mode but not the encoding sub-mode — every modern TUI negotiates SGR, so this is safe in practice.
**Modified keys:** `keyToBytes` was returning bare `ESC[C`/`ESC[D` for arrows, dropping ctrl/shift/alt — so ctrl+←/→ word-jumps did nothing in the PTY. Now it encodes the standard xterm modifier param (`1 + shift + 2·alt + 4·ctrl`) as `ESC[1;{mod}{final}` for arrows/home/end and `ESC[{code};{mod}~` for pgup/pgdn/del.
**Per-terminal notes persist by title.** A note is a live scratchpad you keep *about* a session ("chasing the idle-trim bug"), so it should survive quitting and reopening, but sessions are ephemeral (`t1`, `t2`, regenerated each run) — there's no stable id to key on. The title *is* the stable, human-meaningful handle, so notes live in `~/.destedtui/config.json` under `termNotes` keyed by title, a new terminal loads any note stored under its title, and a rename re-keys the note so it follows the name. Consequence: two sessions with the same title share one note — fine, titles are unique at creation and this is a personal tool.
**Rejected:** one uniform wheel behaviour (either breaks pagers or breaks the shell); gating SGR on a detected encoding sub-mode (xterm-headless doesn't expose it, and no real app needs the gate); session-only notes (lost on quit — the user explicitly wanted them stored); keying notes by generated session id (meaningless across runs) or persisting on every keystroke (needless config churn — save on enter, the live draft in the strip is the real-time feedback).

## 2026-08-01 — `dested` and `term` are shell entry points, not a renamed bin
**Why:** "make the shortcut `dested` not `destedtui`" + "a `term` shortcut that goes right in". Renaming the npm bin would break `bun link`, every `Get-Command destedtui` guard, and the installed profile block, for no gain. Instead the shell integration (`shell/destedtui.ps1`) adds `Set-Alias dested → destedtui` (the entire CLI under the shorter name: `dested --backup`, `dested --local`, …) and a `term` function that runs `destedtui --term` so the multiplexer's panes open in the shell's current directory — no cd handoff, since `term` isn't a project picker. `proj`/`pj` stay as-is.
**Rejected:** renaming the bin in package.json (churn + breakage); making `dested` bare open the picker instead of the menu (that's what `proj` is for — `dested` mirrors the bin); a cd handoff for `term` (nothing to cd to — you stay put and panes inherit cwd).

## 2026-08-01 — Embedded terminals go through a Node pty-host sidecar
**Why:** the `term` multiplexer needs *interactive* PTYs (real `claude`, real shells) rendered in-app. On Windows under Bun that path is blocked twice over: `Bun.Terminal` throws "PTY not supported on this platform" (POSIX-only), and `node-pty`'s native ConPTY binding **loads and reads** under Bun but its input pipe is a `net.Socket({fd})` over a Windows named pipe that Bun closes → every write is `ERR_SOCKET_CLOSED` (proven with spikes). Node drives that same pipe fine. So terminals live in a tiny **Node sidecar** (`ptyhost/host.mjs`, `@lydell/node-pty`) that the Bun TUI spawns and talks to over stdio with line-delimited JSON (spawn/write/resize/kill ↔ data/exit). One sidecar hosts every pane; killing it (or losing its stdin) frees every PTY, so nothing orphans — verified: quit or abrupt terminal-close leaves 0 `host.mjs` and 0 children. Raw PTY bytes are fed to one **`@xterm/headless`** emulator per session (VS Code's engine — handles claude's alt-screen/colors/cursor), and a custom opentui `Renderable` blits that cell grid via `OptimizedBuffer.setCell` (native, not React spans). **This does NOT reverse the 2026-07-28 "no nested pty" decision** — that governs the *card dev/claude buttons*, which still hand off to your real shell and own the whole terminal. `term` is a separate, opt-in mission-control surface.
**The shell is pwsh, not cmd** — panes run `pwsh` (fallback `powershell.exe`) with your **full profile** (oh-my-posh/PSReadLine/aliases — "all my shit"), spawned with `DESTEDTUI_NO_AUTOSTART=1` so the profile's own picker auto-launch (`shell/destedtui.ps1`) doesn't recurse inside a pane. A claude pane is `pwsh -NoLogo -NoExit -Command "claude --dangerously-skip-permissions"` (runs after the profile settles, survives claude exiting) rather than typing the command in — a slow profile races keystrokes.
**Cleanup is belt-and-suspenders** (the "free all the shit" requirement): (1) graceful quit → `PtyHost` tree-kills the sidecar on `process.exit`; (2) the sidecar tree-kills itself on stdin-EOF *and* on shutdown (`taskkill /T` reaps conhost + any profile-spawned grandchildren, not just `pty.kill`); (3) a **PID watchdog** — the sidecar is handed the Bun PID and polls it every 1.5s, self-destructing when it vanishes, because Windows doesn't reliably close the stdin pipe when Bun is killed hard. Verified: quit AND `taskkill /F` on Bun both leave 0 sidecars / 0 pwsh. Each session is exactly 1 pwsh + 1 conhost under the sidecar.
**Rejected:** `Bun.Terminal` (unsupported on Windows); calling `node-pty` directly from Bun (write path is broken); `fs.writeSync` straight to the conin pipe from Bun (blocking `open` on the named pipe hung the process); a hand-rolled VT emulator (claude's TUI would render wrong — xterm is the same engine VS Code trusts); rendering cells as React `<text>` spans (1920 spans/frame vs one native `setCell` loop); external Windows Terminal windows (robust, but not the in-window panes the user asked for); `cmd.exe` (not the user's shell — the whole point is their configured pwsh).

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
