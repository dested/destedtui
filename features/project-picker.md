# Feature — Project picker (`proj`)

**Status:** done · shipped 2026-07-28 · fuzzy filter + command shortcuts 2026-07-30

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
Keys: type to filter · `↑↓←→` move · `enter` go/run · `tab` cycle sort (most used
→ last touched → name) · `esc` clears the filter, or leaves if it's empty ·
`ctrl+u` clears · `ctrl+n` new command · `home`/`end`/`pgup`/`pgdn`.

### Fuzzy / camelCase filtering

`lib/fuzzy.ts` is an fzf-style scorer: the query has to appear in order, and the
score is built from where the characters land, not just that they're present.

| You type | You get | Why |
| --- | --- | --- |
| `frop` | `frozenropes` | `f` at the head, `rop` as a run |
| `sps` | `sals-powershell-setup` | every letter is a word start → acronym bonus |
| `dtui` | `destedtui` | run of three after the head |
| `pg` | `pg-backup` | prefix bump on top of the fuzzy score |

Bonuses (constants at the top of `fuzzy.ts`): head 18, word start 12, camelCase
hump / first digit 10, consecutive 8, every match 16; gaps cost −3 to open and
−1 to widen; +10 per character when **every** match landed on a word start, which
is what stops `sps` preferring `slopshow`. Trailing text is free, so a long name
isn't punished for being long — ties fall through to frecency, as before.

On top of that, `matchProject` adds +1000 for an exact name and +400 for a
prefix, so muscle memory always beats a clever subsequence elsewhere in the list.
The pkg name (×0.7) and stack (×0.45) still match, weighted under the folder
name. Matched characters are drawn in teal on the card so a hit explains itself.

### Command shortcuts

Things you run all day, as cards in the same grid: type `cc`, press enter, and
`bunx ccusage` runs **in the directory your shell is already in** — no cd, no
frecency entry. They sort ahead of projects (a handful of them would otherwise
drown in 220 folders) and an exactly-typed name wins outright.

| Key | Does |
| --- | --- |
| `ctrl+n` | new shortcut — `name` / `command`, `tab` switches field, `enter` saves |
| `ctrl+e` | edit the highlighted shortcut |
| `ctrl+x` | delete it (`enter` confirms, `esc` keeps it) |

Stored in `~/.destedtui/config.json` as `commands: [{ name, command }]`; a missing
key seeds `cc → bunx ccusage`, an empty array means you deleted them all and is
left alone. Names are normalised to lowercase-kebab so they're typeable in the
filter. The form is hand-rolled rather than an `<input>` for the same reason the
search line is, and every keystroke goes through a functional `setState` —
several key events can arrive before React re-renders, and a value-form update
keeps only the last character.

### Card buttons

Each card carries its own click targets, which `stopPropagation` so the card's
own cd doesn't also fire:

| Button | Runs | Key |
| --- | --- | --- |
| `▶ dev` | `<pm> run dev` (or `start`/`serve`), pm from the lockfile. Absent when the project has no such script. | `ctrl+d` |
| `✦ claude` | `claude --dangerously-skip-permissions` | `ctrl+k` |

Both cd first, then run **in your shell** — destedtui has already exited, so the
command owns the terminal. That's the point: an interactive agent can't live
inside a nested TUI.

The screen owns its own type-ahead rather than mounting an `<input>`, because a
focused input swallows `←`/`→` as cursor moves and the grid needs them.

### Typing what you'd have typed at a prompt

The picker replaces a prompt, so half the time you type `cd drydock` out of
habit. `parseQuery` strips the part that isn't a project name and dims it in the
search line, so it never looks like the filter broke:

| You type | Matched on |
| --- | --- |
| `cd drydock`, `cod dry`, `z dry`, `zi`/`ls`/`dir`/`pushd` + name | the name |
| `g:\code\drydock`, `cd G:/CODE/DryDock` | `DryDock` |
| `cd g:\code\drydock\src` | `drydock` (we can only jump to a project) |
| `cd` / `cdk` / `code` alone | themselves — a verb only counts with a space after it |

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
   to that file (`lib/cd.ts`) — **line 1 the directory, optional line 2 a
   command** — tears the renderer down, **clears the screen and scrollback**,
   prints `➜  cd <dir>` (and `➜  <command>`), exits.
3. `proj` reads the file, deletes it, `Set-Location`s, and `Invoke-Expression`s
   the command if there is one.

Run without the wrapper and it still prints the path plus a hint to run
`destedtui --install-shell`.

## Where the block sits, and what "slow" means

`install.ps1` puts the block **directly after any `using` statements**, near the
top of the profile — not at the end. The picker owns the terminal until you
choose, so anything the profile does before it is time you spend staring at
nothing. Up top it paints in ~400ms and the rest of the profile runs once you've
picked.

Measured on this machine (warm):

| Phase | Cost |
| --- | --- |
| bun start + module graph | ~280ms |
| `@opentui/core` import | 111ms |
| `scanProjects` (221 folders, incl. zoxide) | 47ms |
| `createCliRenderer` | 10ms |
| **launch → first painted frame** | **~400ms** |
| the profile itself, without the picker | ~430ms warm / ~740ms cold |

If PowerShell reports something like `Loading personal and system profiles took
6056ms`, that is **not** startup cost: the picker runs inside profile loading,
so PowerShell's timer keeps counting while the picker sits there waiting for you
to click. The number is mostly your own dwell time.

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
`src/components/CommandCard.tsx` · `src/components/CommandEditor.tsx` ·
`src/components/Highlight.tsx` · `src/lib/projects.ts` · `src/lib/fuzzy.ts` ·
`src/lib/commands.ts` · `src/lib/text.ts` · `src/lib/cd.ts` ·
`src/lib/config.ts` · `shell/destedtui.ps1` · `shell/install.ps1`
