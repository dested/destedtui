# Feature — Project picker (`proj`)

**Status:** done · shipped 2026-07-28

## What it does

A **grid of cards**, one per folder in `g:\code` (221 of them), ranked by how
often you actually open it. **Click a card and you're there** — the TUI clears
the screen and the calling shell is now in that directory. It opens by itself in
every new terminal that starts in `g:\code`, so a fresh Windows Terminal tab is
a project menu.

## How to use it

| Where | How |
| --- | --- |
| New terminal in `g:\code` | opens automatically |
| Any shell | `proj` (or `pj`) |
| Inside destedtui | the "Projects" tile on the menu |
| Scripted | `destedtui --projects` (also `-p`, `--cd`) |

Mouse: hover highlights, **single click goes** (no confirm step), wheel scrolls.
Keys: type to filter · `↑↓←→` move · `enter` go · `tab` cycle sort (most used →
last touched → name) · `esc` clears the filter, or leaves if it's empty ·
`ctrl+u` clears · `home`/`end`/`pgup`/`pgdn`.

The screen owns its own type-ahead rather than mounting an `<input>`, because a
focused input swallows `←`/`→` as cursor moves and the grid needs them.

## Ranking

`score = own frecency + zoxide score`, sorted desc, ties broken by last-touched.

- **Own frecency** — `opens × decay(age)` using zoxide's curve (≤1h ×4, ≤1d ×2,
  ≤1w ×0.5, else ×0.25). Every pick writes `projectOpens` in
  `~/.destedtui/config.json`.
- **zoxide seed** — `zoxide query --list --score`, with any path *under* a
  project folded into that project. This is why the list is useful on day one
  instead of starting alphabetical. No zoxide installed = own opens only.

## The `cd` handoff

A child process cannot change its parent's directory. So:

1. `proj` creates a temp file and exports `DESTEDTUI_CD_FILE`.
2. On click/enter, `App.chooseProject` records the open, writes the chosen path
   to that file (`lib/cd.ts`), tears the renderer down, **clears the screen and
   scrollback**, prints `➜  cd <dir>`, exits.
3. `proj` reads the file, deletes it, and `Set-Location`s.

Run without the wrapper and it still prints the path plus a hint to run
`destedtui --install-shell`.

## Auto-launch guard

`Test-DestedTuiAutostart` in `shell/destedtui.ps1` fires **only** when: not
`DESTEDTUI_NO_AUTOSTART`, host is `ConsoleHost`, `UserInteractive`, not
`CLAUDECODE`/`CI`, no `-Command`/`-File`/`-EncodedCommand`/`-NonInteractive` on
the command line, `destedtui` is on PATH, and the shell started in the projects
root exactly. A shell opened *inside* a project never interrupts you.

## Status line

The highlighted project (only that one) gets a 120ms-debounced `git status
--porcelain -b` + `git log -1`, rendered as one line under the grid: path,
ahead/behind, dirty count or `✓ clean`, and the last commit. Stale replies are
dropped by sequence number, so sweeping the mouse across cards is free. A `.git`
that git itself rejects shows a red `⚠ .git is there but unreadable` — true for
29 repos on this machine.

## Files

`src/screens/Projects.tsx` · `src/components/ProjectCard.tsx` ·
`src/lib/projects.ts` · `src/lib/cd.ts` · `src/lib/config.ts` ·
`shell/destedtui.ps1` · `shell/install.ps1`
