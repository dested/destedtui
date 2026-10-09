# destedtui — Verify

> How to prove the app works. Scale to the change: [cheap] always,
> flow recipes when touched, [heavy] only after asking.

## Commands

| What | Command | Cost |
| --- | --- | --- |
| Type-check | `bun x tsc --noEmit` | [cheap] |
| CLI plumbing | `bun run src/index.tsx --help` / `--version` | [cheap] |
| Shell integration installed | `Get-Command proj` in a new shell; `install.ps1 -WhatIf` shows the resolved profile | [cheap] |
| Boot without crash | run `destedtui` in a real terminal, see menu render, `q` quits | [cheap] |
| Global bin intact | `destedtui --version` from another directory | [cheap] |
| Review bin intact | `review --help` from any repo; `review --dry-run` prints the assembled prompt | [cheap] |

No unit-test runner. Core-logic smoke and full e2e are ad-hoc scripts (patterns below).

## Test accounts / data

Postgres credentials come from whatever project `.env` you point it at — never stored in this repo. For e2e, local dev DBs exist in `G:\code\changehowilook\.env` and `G:\code\beep-demo\web\.env` (localhost:5432; server is PostgreSQL 18.x as of 2026-07).

## Critical flows

### Project picker [cheap]
Touchpoints: `src/lib/projects.ts`, `src/screens/Projects.tsx`, `src/lib/cd.ts`
1. Scratch script: `scanProjects(projectsRoot())` → expect ~220 rows, scan under ~100ms, branches populated, `inspectProject` on a known repo returning branch/dirty/last-commit.
2. In a **real** terminal: `proj`, click a card (or type a name + enter) → screen clears, the shell is now in that folder and printed `➜  cd …`; `~/.destedtui/config.json` gained a `projectOpens` entry and that project floats up the grid next time.
3. `esc` with a filter typed clears the filter; `esc` again closes and the shell stays put.
4. Card buttons: point `DESTEDTUI_CD_FILE` at a temp file, run `--projects`, click `▶ dev` / `✦ claude` / the card body, and read the file — expect `[dir, "<pm> run dev"]`, `[dir, "claude --dangerously-skip-permissions"]`, and `[dir]` respectively. Buttons that don't `stopPropagation` show up as a missing second line.

### Fuzzy filter + command shortcuts [cheap]
Touchpoints: `src/lib/fuzzy.ts`, `src/lib/commands.ts`, `src/screens/Projects.tsx`
1. Scratch script over the real list: `matchProject` for `frop` → `frozenropes` first, `sps` → `sals-powershell-setup` first, `dtui` → `destedtui` first. A regression here usually means a bonus constant moved.
2. In tmux (recipe below): `ctrl+n`, type a name, `tab`, type a command **fast** (`send-keys -l` sends them in one burst — that's the point, it reproduces batched key events), `enter`. Then read `~/.destedtui/config.json`: the whole string must be there, not just its last character.
3. `ctrl+x` on that card → confirm box shows BOTH the `⚠ name — command` line and the hint line → `enter` → gone from config.json.
4. Handoff: point `DESTEDTUI_CD_FILE` at a temp file, run `--projects`, type `cc`, `enter` → the file holds the **current** directory on line 1 and `bunx ccusage` on line 2, and no `projectOpens` entry was written.

### Driving the picker with a real mouse [cheap]
tmux `send-keys -H` does NOT decode hex in this psmux build (it types the digits). Send the escape byte instead: `ESC=$(printf '\033'); tmux send-keys -t <s> -l "${ESC}[<0;COL;ROWM"` to press and `...m` to release; button 35 is motion, which is how you test hover. Cards are `CARD_MIN_WIDTH`-derived, so read the coordinates off a `capture-pane` first rather than computing them.

### Picker rendering in tmux [cheap]
opentui paint bugs don't show up in a typecheck. `tmux new-session -d -s t -x 170 -y 48 -c G:\code\destedtui`, send `bun run src/index.tsx --projects`, then `tmux capture-pane -p -t t`.
Look for: full rows of cards with the last column flush against the panel edge, no half-drawn card borders after typing a filter that shrinks the grid, the status line present. Then repeat at `-x 92` — it should reflow 5 columns → 3, not clip.
Caveat: capture-pane under psmux drops cells, so *some* raggedness is the capture, not the app — the pre-existing menu screen shows it too. Trust the structural checks above, not exact column alignment.

### Autostart guard [cheap]
It cannot fire inside an agent shell (`CLAUDECODE` is set and the host launches pwsh with `-Command` — both deliberate refusals). Test the predicate directly instead: dot-source `shell/destedtui.ps1` with the trailing `if (Test-DestedTuiAutostart) { proj }` line stripped, then call `Test-DestedTuiAutostart -CommandLine @('…pwsh.dll') -Location 'G:\code'` (expect `True`) versus a project subfolder, an unrelated path, and `-Command`/`-File` argument lists (expect `False`).

### Localhost screen [cheap]
Touchpoints: `src/lib/ports.ts`, `src/screens/Ports.tsx`
1. Scratch script: `scanServers({ all: false })` → every node/bun listener with cwd + cmdline populated and a sensible `killRoot` (e.g. `bun run dev` above `bun --watch server.ts`), under ~60ms.
2. tmux (**`export MSYS_NO_PATHCONV=1` first**, or `/` arrives as `C:/Program Files/Git/`): `bun run src/index.tsx --ports` at `-x 200 -y 46` and `-x 100 -y 30` — columns aligned, detail pane only at ≥110 cols, status line not overprinting the last row.
3. Kill, safely: a throwaway chain (scratchpad `package.json` with `"dev": "bun server.ts"`, `Bun.serve` on 4999) started with `bun run dev` in another tmux window. Filter `/throw` + enter; `x` → status reads `⚠ kill bun run dev (pid …) + 1 more`; `x` again → `✓ killed`, port 4999 refuses, the other window is back at its prompt. Mouse: move (`ESC[<35;col;rowM`) onto `✕` BEFORE pressing, or the press can land on the row body (which opens Chrome).
4. `g`: point `DESTEDTUI_CD_FILE` at a temp file, select a row, `g` → the file holds that server's cwd.

### Script runner [cheap]
Touchpoints: `src/lib/discovery.ts`, `src/lib/run.ts`, `src/screens/Scripts.tsx`, `src/screens/ProcessView.tsx`
1. In this repo run `destedtui` → Scripts → filter "typecheck" → enter
2. Expect live output, then green `✓ done`; esc twice back to menu

### Review [cheap → heavy]
Touchpoints: `src/review.tsx`, `src/screens/Review.tsx`, `src/lib/review*.ts`, `prompts/`
1. [cheap] `review --help` exits 0; `review --dry-run` prints the prompt with the uncommitted scope block; `review --last 2 --dry-run` names the right base commit; `review --branch` on main exits 2 with "already on".
2. [cheap] In tmux: `review` in a dirty repo → picker renders with live badges (`N files`, `HEAD`, "gh unavailable" when gh is absent); esc quits clean.
3. [heavy — ask first] `review --headless` in a repo with real changes — spawns a paid `claude-opus-4-8` run (2–10 min, ~$1+). Expect streaming `· Tool arg` lines, a report, exit 0/1 matching the findings.

### Keys vault [cheap → live]
Touchpoints: `src/keys.tsx`, `src/screens/Keys.tsx`, `src/lib/keys/`
**Never print a value while verifying** — no `cat` of a `.env` (mask: `sed 's/=.*/=…/'`), no `reveal`.
1. [cheap] Scratch vault + root: `export KEYS_VAULT_DIR=<scratch>/vault DESTEDTUI_PROJECTS_ROOT=<scratch>/root`, a few fake `.env` files (same fake value in two projects, a `VITE_*` alias, a placeholder like `your-key-here`). `keys import` → imports, skips the placeholder, reuse report names both projects. `keys list` shows ⚠ lines.
2. [cheap] `echo <fake> | keys add groq --project alpha --stdin` → stored + `.env` line added + `.env` appended to `.gitignore`; again → exit 1 "already has an active"; with `--replace` → replaced line. `keys add groq --project alpha` (no input flag) → exit 1. `keys new gemini --project beta --no-open` → console next-step text, exit 0. `keys revoke <id of a shared key>` → "same value still active in …", `.env` line gone. `keys reveal <id> --yes-print-secret` inside Claude → exit 1. `ls <scratch>/vault` shows `vault.bin.1..` backups.
3. [cheap] TUI in tmux (`export MSYS_NO_PATHCONV=1`; the pane shell is pwsh, so set env with `$env:X='…'`): `bun run src/keys.tsx` at 170×44 and `bun run src/index.tsx --keys` at 100×30 — group headers, columns, ⚠ badges, row buttons flush right, footer. `g` regroups, `x` arms (red border + status line), `n` shows the form replacing the list, `esc` backs out.
4. [live — spends nothing, touches the real org] `keys new openai --project <scratch>` with `OPENAI_ADMIN_KEY` set and the scratch vault → minted; probe `GET /v1/models` with the stored value from a script (print the status only) → 200; `keys revoke <id>` → "revoked on OpenAI"; probe again → 401. (Passed 2026-10-03.)

### Keys rotate + Drydock [cheap → one live mint]
Touchpoints: `src/lib/keys/{drydock,deployed,push,rotate,verify,activity}.ts`, `src/screens/KeysRotate.tsx`
1. [cheap, read-only portal] `keys drydock --refresh` → every app with its folder + "repo/name/override" or `— unmapped`, and the AI keys in its env as provider + fp + owner (`⚠ shared × N`, `own`, `<project>'s`, `not in vault`). `keys push <deployed project> --dry-run` → "already up to date" or "would update VAR (fp …)". Never run `push` without `--dry-run` against a real project.
2. [cheap] `keys rotate --dry-run` (list), `keys rotate --fingerprint <fp> --dry-run` (overview + every step + finish), `keys rotate --dead --dry-run`. Nothing in the vault changes (`vault.bin` mtime).
3. [cheap] Frames: `bun scripts/snap-keys.tsx --fp <fp> --simulate --keys "wait1500 snap enter enter wait300 enter … snap tab snap"` and `--rotate --simulate --keys "wait1500 snap d snap a snap"`, at `--size 170x44` and `100x30`.
4. [cheap] Resume: scratch vault + root, two folders sharing a fake groq key, `startRotation` + `runStep(create, {clipboard: <fake>})` from a script; a new process's `keys rotate --fingerprint … --dry-run` shows "walk in progress" and step 1 "already done"; the walk view opens on `.env`.
5. [live — one OpenAI service account, no Drydock writes] Scratch vault + root (`rot-alpha`, `rot-beta`): `keys new openai --project rot-alpha`, copy the record to rot-beta from a script, `writeEnv`. snap-keys without `--simulate`: `space` (alpha → new key), `enter enter`, `enter` ×3 (mint, .env, verify OK), `enter` (finish plan), `enter enter` → "old key revoked on OpenAI · 1 records retired · .env lines removed in rot-beta". Probe statuses only: old 401, new 200; then `keys revoke <new>` → 401. (Passed 2026-10-04.)

### Keys usage [cheap — read-only provider calls]
Touchpoints: `src/lib/keys/usage/`, `src/screens/KeysUsage.tsx`, `printUsage` in `src/keys.tsx`
1. `keys usage --refresh` → table sorted by 24h, `⚠ shared × N` lines in red-flag form, a status line per provider (openai/elevenlabs/openrouter ✓ per key; anthropic/xai/fal "needs admin key" until set; gemini/groq/replicate "no usage API").
2. `keys usage --project <p>` → its own line + every shared group it's in, with per-key rows and "matched by …". `--days 40` → exit 1. `--json` parses.
3. No secrets in the cache: `grep -c -E 'sk-|sk_|xai-|gsk_|r8_' ~/.destedtui/keys/usage.json` → only the literal `sk-ant-admin…` hint text.
4. tmux at 170×44 and 100×30: `bun run src/keys.tsx`, `u` → Usage view; ↓ onto a shared line → the detail strip says it can't be split and names the key; `u` back to the list (not `q` — that leaves the screen).

### Claude usage [cheap — read-only]
Touchpoints: `src/lib/claude/`, `src/screens/ClaudeUsage.tsx`
1. `bun src/index.tsx --usage --days 7` → header line + projects table + day log; a second run takes ~1–2s (warm cache). `--json` parses; `--project <name>` lists its sessions.
2. Pricing check: sessions with a `"type":"cost-state"` line carry Claude Code's own `totalCostUSD`; single-model sessions must match ours to the cent (mixed ones read ~5% low — background Haiku isn't in transcripts).
3. Frames, no tmux (psmux misdraws diffed rows): `bun scripts/snap-claude.tsx --size 180x46 --keys "snap 2 snap left left snap 3 snap 4 snap d snap"` and again at `100x30` — columns aligned, timeline total column flush right, footer fits.
4. Drill-down: `--keys "enter snap escape snap"` → sessions filtered to the top project (`▸ name` in the tab row), esc clears the filter.
5. Buttons, with real mouse clicks (`click:<label>`, `_` = space): `--size 120x34 --keys "click:2_timeline click:weeks snap click:◀ snap click:≡_sessions snap click:✕_clear click:1_projects click:recent snap click:←_back snap"` → weekly grid, cursor moves a week, sessions scoped to that week, filter clears, sort flips to recent, back lands on the menu.
6. Other screens' buttons: `--route ports|keys|rotate|rotate-dead|term` (the rotate routes open in simulate). E.g. `--route rotate --keys "wait500 click:<fp> click:^▶_start click:^⚠_confirm wait1500 snap"`. Never click `✓ go` / `⧉ read clipboard` / `✕` revoke on the real `keys` route.

### bx daemons [cheap → spawns one headless daemon]
Touchpoints: `src/lib/bx.ts`, `src/screens/Bx.tsx`, bx `src/daemon/debug.ts`
1. A test daemon: `cd G:\code\bx && MSYS_NO_PATHCONV=1 bun src/cli.ts --profile bxtop --headless open about:blank`. Never stop, kill or gc another session's daemon to test.
2. Frames: `bun scripts/snap-claude.tsx --route bx --size 200x48 --keys "wait2500 click:bxtop snap 2 snap 3 snap 4 snap 5 snap"` and again at `100x30` (detail replaces the list; `enter` opens it). Expect `● bxtop idle`, a driver line naming this session, the `open about:blank` command in activity, and a log tail with no ANSI escapes.
3. Actions on the test daemon only: `--keys "wait2500 click:bxtop g wait400 snap h wait1500 snap"` → `⟳ gc bxtop: heap …` and `⛁ …\.bx\heaps\bxtop-….heapsnapshot` (delete it afterwards); `x x` → `■ stopped bxtop` and `~/.bx/run/bxtop.json` is gone.
4. Scanner leak guard: run `processTable()` ×1000 in a loop and sample `processTable().procs.get(process.pid).commit`. It must stay flat (within ±30 MB), where the TextDecoder leak grew +340 MB.

### Core-logic smoke (no DB needed) [medium]
Touchpoints: `src/lib/discovery.ts`, `pgurl.ts`, `zip.ts`
Write a scratch script (outside the repo) that builds a fake monorepo + `.env`, then asserts: `discover()` finds packages/dbs, `parsePgUrl` decodes an encoded password, and `createBackupZip` → `readZipMetadata` → `extractZipEntry` round-trips a few MB byte-identically.

### Backup → restore e2e [heavy — ask first]
Requires: reachable Postgres with credentials; creates/drops `destedtui_smoke*` databases; first run per server major downloads ~300MB of EDB tools into `~/.destedtui/pg`.
1. Seed a scratch DB (`destedtui_smoke`, 500 rows incl. jsonb), point a temp `.env` at it
2. `startBackup` → expect `pgbackup-*.zip` next to the `.env` with metadata
3. `startRestore` mode "new" → row count + `max((data->>'sq')::int)` match seed
4. `startRestore` mode "overwrite" → rows match again; drop both scratch DBs

### Localhost target / pull / local-DB e2e [heavy — ask first]
Requires: a **localhost** Postgres (`postgres@localhost:5432`, PG 18.x; password from your local env / the Local Postgres connection editor). Creates/drops `destedtui_smoke_*` DBs.
Copy a scratch script into the repo (relative imports resolve from there), e.g. `.smoketest.ts`, and `bun ./.smoketest.ts`; delete after. It should:
1. `createLocalDatabase` a source + seed rows.
2. `startPull(source.url, {conn: localPgConn(local, DST), mode:"new"})` → assert restored row count.
3. `startRestore({path: <a .sql file>}, {conn: localPgConn(local, SQL), mode:"new"})` → assert psql path loads rows.
4. `startPull(..., mode:"overwrite")` on the existing DST → rows match again (drop+recreate works).
5. `listLocalDatabases` shows all three; `dropLocalDatabase` cleans them up in `finally`.
(This exact script passed vs live PG 18.3 on 2026-07-18.)
