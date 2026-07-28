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

### Driving the picker with a real mouse [cheap]
tmux `send-keys -H` does NOT decode hex in this psmux build (it types the digits). Send the escape byte instead: `ESC=$(printf '\033'); tmux send-keys -t <s> -l "${ESC}[<0;COL;ROWM"` to press and `...m` to release; button 35 is motion, which is how you test hover. Cards are `CARD_MIN_WIDTH`-derived, so read the coordinates off a `capture-pane` first rather than computing them.

### Picker rendering in tmux [cheap]
opentui paint bugs don't show up in a typecheck. `tmux new-session -d -s t -x 170 -y 48 -c G:\code\destedtui`, send `bun run src/index.tsx --projects`, then `tmux capture-pane -p -t t`.
Look for: full rows of cards with the last column flush against the panel edge, no half-drawn card borders after typing a filter that shrinks the grid, the status line present. Then repeat at `-x 92` — it should reflow 5 columns → 3, not clip.
Caveat: capture-pane under psmux drops cells, so *some* raggedness is the capture, not the app — the pre-existing menu screen shows it too. Trust the structural checks above, not exact column alignment.

### Autostart guard [cheap]
It cannot fire inside an agent shell (`CLAUDECODE` is set and the host launches pwsh with `-Command` — both deliberate refusals). Test the predicate directly instead: dot-source `shell/destedtui.ps1` with the trailing `if (Test-DestedTuiAutostart) { proj }` line stripped, then call `Test-DestedTuiAutostart -CommandLine @('…pwsh.dll') -Location 'G:\code'` (expect `True`) versus a project subfolder, an unrelated path, and `-Command`/`-File` argument lists (expect `False`).

### Script runner [cheap]
Touchpoints: `src/lib/discovery.ts`, `src/lib/run.ts`, `src/screens/Scripts.tsx`, `src/screens/ProcessView.tsx`
1. In this repo run `destedtui` → Scripts → filter "typecheck" → enter
2. Expect live output, then green `✓ done`; esc twice back to menu

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
