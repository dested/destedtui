# destedtui — UI / Visual Language

> The source of truth for how destedtui **looks and feels** in the terminal.
> Follow it for anything visual. Keep current as part of the definition of done.

## North star

**"Tokyo Night command deck."** Dark, saturated-accent terminal UI that feels like a purpose-built cockpit, not a shell script with colors. Reference: lazygit's density + Tokyo Night VS Code theme's palette. Failure modes: too sterile = default white-on-black with no accent structure; too toy = rainbow everything, every line a different color.

1. **One palette, from `src/theme.ts` (`T`)** — never inline a hex that isn't in `T`.
2. **Color means something** — green = success/counts, red = destructive/error, yellow = in-flight, dim for everything secondary. Accent colors (purple/blue/cyan) identify screens, not decorate lines.
3. **Every screen tells you its keys** — a `<Footer hints>` bar is mandatory on every screen.
4. **Motion = spinner only** — braille `SPINNER_FRAMES` at ~90ms while work runs; no other animation.

## Tokens (src/theme.ts)

| Token | Value | Use |
| --- | --- | --- |
| `T.bg` | `#16161e` | app background |
| `T.panel` | `#1a1b26` | screen panels, footer |
| `T.surface` / `T.surfaceAlt` | `#24283b` / `#292e42` | progress track, alt rows |
| `T.selectionBg` | `#2f3449` | ListPicker selected row |
| `T.border` | `#3b4261` | all resting borders |
| `T.fg` | `#c0caf5` | primary text |
| `T.dim` | `#565f89` | secondary text, hints, disabled |
| `T.blue` | `#7aa2f7` | backup accent, selection caret |
| `T.purple` | `#bb9af7` | brand, menu title, badges |
| `T.green` | `#9ece6a` | success, safe badges, done borders |
| `T.red` | `#f7768e` | errors, destructive labels |
| `T.yellow` | `#e0af68` | running status |
| `T.orange` | `#ff9e64` | restore accent, stderr lines |
| `T.cyan` | `#7dcfff` | key hints, icons, process title |
| `T.teal` | `#73daca` | projects accent (title, active filter border, sort mode) |
| `T.pink` | `#ff007c` | review accent (Tokyo Night magenta) |

Accent discipline: each screen owns one accent for its border title (`titleColor`) — menu purple, projects teal, scripts green, backup blue, restore orange, process cyan, review pink, localhost blue (the palette ran out; backup and localhost are never on screen together), keys orange (shared with restore, same reasoning), claude usage purple (shared with the menu — you're never on both), bx daemons teal (shared with projects, same reasoning). Status colors are earned by state, never used for decoration.

## Layout

Every screen = same shell: `Header` (ascii-font "DESTED" gradient purple→blue→cyan; on the right, the cwd with its **leaf folder loud** — bright `T.teal` + bold behind a `⌂` glyph, parent path dim — because "which project am I in" is the question the header answers) → one rounded-border panel (`margin: 1, marginTop: 0, padding: 1`, `backgroundColor: T.panel`, titled ` lowercase name `) → `Footer` hint bar. The panel border turns `T.green`/`T.red` on terminal success/failure states.

**Card grid** (projects): inside the panel, a one-line search row → a fixed-height grid of rounded cards → a one-line status row. Columns come from `floor((inner + gap) / (CARD_MIN_WIDTH + gap))` and the leftover is divided back into the card width, so the grid always fills the panel edge to edge and reflows from 5 columns to 3 on a narrow terminal. Card = 6 rows: `◈ name` + stack badge, a dim description line, branch + age + open count, then a row of action buttons. Selected card gets a `T.teal` border and `T.selectionBg` fill.

**Command cards** share the grid and the card rect exactly, so there is one caret and one set of keys: `▸ name` + a purple `cmd` badge, the command line dim underneath, `runs where your shell is`, then `▶ run` / `✎ edit` / `✕`. Purple border when selected (projects are teal) — the colour is the whole difference between "a place" and "a thing that runs".

**Matched characters** in a card name are drawn in `T.teal` while the rest stays `T.fg`, so a fuzzy hit explains itself. Only the folder/command name highlights; a hit on the pkg name or stack highlights nothing rather than lying about where it matched.

**Modal panels** (the add/edit form, the delete confirm) **replace the grid** — same rect, same explicit height — instead of floating over it. An overlay would leave the cards it covered painted underneath. Their fields are hand-rolled, not `<input>`s, for the same reason the search line is (below).

**Buttons** are a one-row `box` with `T.surfaceAlt` background and one cell of padding either side, label in the action's own colour (`▶ dev` green, `✦ claude` purple). A button inside a clickable parent must `stopPropagation()`, and every button keeps a keyboard twin — but the footer no longer lists letter twins (see Action bar).

**The terminal pane** (`Term.tsx`) carries a one-line **note strip** just under its status row and above the emulator: `✎ note: <text>` (blue icon, `note:` dim, text `T.fg`), or a dim `✎ press t for a note` when empty, or the live draft with a `▏` caret in `T.yellow` while editing. It's a fixed height-1 row so it never reflows the terminal grid.

**Table rows** (localhost): one line per item in fixed columns — caret, health dot, port, project (name `T.fg`, monorepo sub-path dim), command dim, runtime (node green, bun orange), uptime dim, memory (dim → yellow ≥600M → red ≥1G) — then the row's own fixed-width buttons (`↗` cyan, `✕` red). Destructive buttons live **on the row, never in a side pane**: hover selects, so a mouse travelling to a detail-pane button crosses other rows and retargets it. A kill arms on the first press (`✕?` on a red fill, panel border red, the status line names exactly what dies) and fires on the second within 3s.

**Grouped table** (claude procs, accent cyan): group header rows on `T.surfaceAlt` (`▾/▸` fold, status dot — busy yellow, idle dim, orphans `⚠` orange — bold name, dim label, unit count, cpu/mem/up, `✕ all`), unit rows under them in the localhost column style (port cyan, command, tags — red when hot, yellow for ×N dupes, cyan mcp/daemon — cpu as % of one core: dim → fg ≥5% → yellow ≥30% → red ≥90%). Quiet units fold into one dim `+ N quiet: tail ×3, grep ×2` row; a click unfolds. Sort steps in quarter cores so rows don't trade places every scan.

**Two-line rows** (bx daemons, accent teal): each item is 2 rows, so scroll and hit-testing count items, not lines. Line 1 is identity and state: caret, state glyph (`●` yellow in flight, `◉` red recording, `●` green idle, `○` dim no browser, `◌` orange old daemon, `✕` red down), the profile in one shared column width across every row, the state text, uptime, then the `■ stop` row button. Line 2 is numbers, dim labels and values in `T.fg`: memory, `×N` processes, a cyan sparkline, growth/min (dim when flat, yellow ≥1 MB/min, red ≥10 MB/min), cpu, `by <driver>`. Orphans are `⚠` orange rows with `✕ kill` / `✕ clear`. Sparklines are min-max scaled and drawn flat under 1% movement, so noise doesn't look like a leak. The detail pane sits beside the list at ≥120 cols, otherwise it replaces the list with a `← list` button. Its view tabs are a `seg` in the pane's own action bar, and the row-scoped actions (gc, heap snapshot, kill tree) go in the pane's second bar, which the mouse reaches sideways.

**Tabbed views** (claude usage): one row of ` 1 projects ` tabs on the left (active tab accent-on-`selectionBg`) and range chips on the right (active chip cyan on `surfaceAlt`), both clickable; a live filter sits between them in teal (`▸ drydock`) or yellow while typing (`/text▏`). Below: a summary line, the column header, the rows, a fixed 3-row detail strip for the selected row, and a status line.

**Action bar** (`components/ActionBar.tsx` — claude usage, localhost, keys, keys usage, rotate): one row above the status line holding every screen-level toggle and action as a button — never a letter key the user has to remember. Built from `btn(label, color, onPress)` and `seg(label, options, value, onChange)` (a segmented control: optional dim label, adjacent chips, active cyan on `selectionBg`, the rest dim on `surfaceAlt`). Actions sit left with 2-cell gaps, back (and rescan) flush right; actions that don't fit drop off the end, so put the important ones first. **Only screen-level controls go in the bar** — sort, mode, range, rescan, a wizard's next step. Anything that acts on the selected row is a button *on the row* (or in a side detail pane, which the mouse reaches sideways): hover selects, so a mouse travelling down to the bar crosses other rows and retargets it. A two-press action arms in place (`⚠ confirm: …`, back becomes `✕ cancel`). Letter keys stay as silent aliases; the footer shrinks to click / ↑↓ / enter / esc. A filter lives in the filter row itself: a `⌕ filter` button, then the text being typed and a `✕ clear`.

**Heatmap** (claude usage timeline): project label column, then one 1–4-cell column per day — or 1–12 cells per Monday-start week in weeks mode — (sized to fill the panel), then a right-aligned total. Empty day `·` in `T.border`; activity `░▒` in `T.blue`, `▓█` in `T.cyan`, on a sqrt scale so small days still show. The cursor day is a `T.surface` column (`T.border` on the selected row). Header labels `MM-DD` sit on Mondays (on every week in weeks mode).

**Click is the primary input.** Hover selects, a single click acts — no select-then-confirm. Anything a mouse can do the keyboard must do too (arrows + enter), but the footer only advertises click, arrows, enter and esc — never a wall of letter shortcuts (Sal, 2026-10-04: buttons, not letter toggles).

## Painting (learned the hard way)

A box paints only the rect it occupies; opentui does not clear what a shrinking or moving element vacates. So:

- **Give anything variably-sized an explicit width/height.** A `flexGrow` column sizes to its content, so a filter that shortens the longest row slides the neighbouring pane sideways and leaves a copy of it behind.
- **Fill the first frame.** Populate lists in `useState(() => …)`, not an effect, and seed the highlighted selection — an empty first frame paints torn rows that never repaint.
- **A bordered box is border 2 + padding 2 + its lines.** Come up one row and the top line is clipped with no error at all.
- **Budget `visible + 2` rows** for a `ListPicker` (the `▲/▼ N more` counters are extra lines), or the counter draws on top of a row.

## Components

| Component | File | Purpose |
| --- | --- | --- |
| `Header` | `src/components/Header.tsx` | brand row; takes `subtitle` (cwd) — splits it and paints the leaf folder bold-teal behind `⌂`, parent dim |
| `Footer` | `src/components/Footer.tsx` | hint bar; `hints: [key, label][]`, key in cyan, label dim |
| `ListPicker` | `src/components/ListPicker.tsx` | ALL lists: `❯` caret, icon, title, dim subtitle, right badge, disabled rows, windowing with `▲/▼ N more`, mouse click |
| `ProjectCard` | `src/components/ProjectCard.tsx` | one grid cell; every line padded to the card's inner width |
| `CommandCard` | `src/components/CommandCard.tsx` | the same cell for a saved shortcut; purple, `▸` |
| `CommandEditor` | `src/components/CommandEditor.tsx` | add/edit form and delete confirm; replace the grid |
| `Highlighted` | `src/components/Highlight.tsx` | a padded line with matched characters in a second colour |
| `ProgressBar` | `src/components/ProgressBar.tsx` | flat block bar + dim percent |

Signature row (ListPicker item): `❯ ▶ title  dim-subtitle` … `badge` — icons are single unicode glyphs (▶ ▸ ⛁ ↺ ⎇ ☰ ✕ ✎ ◈ ◇ ▣ ◷ ↻ ⌂ ⚠). Health dots (localhost): `●` green = answered HTTP, `●` red = 5xx, `◌` yellow = accepted but silent, `○` dim = not HTTP, spinner = probing. Project rows: `◈` git repo, `◇` plain folder; the badge is the detected stack, coloured per language. Command rows: `▸`. Keys: `◆` group headers in orange, the fingerprint is the only identifier shown (cyan when selected), reuse warnings `⚠ same key in N projects` in red (it's a security problem, not decoration), shortened to `⚠ N projects` on a narrow terminal. Usage view: owner lines (project `T.fg`, `⚠ shared × N` red, unmatched/account dim), a 24h figure turns `T.yellow` at ≥ $1, sparklines `▁▂▃▄▅▆▇█` in cyan with `·` for empty days, and a fixed 4-row detail strip under the table for the selected line's keys. Rotate screen: same panel + accent; overview rows carry activity (green when < 30 days), Drydock marks `●` holds / `?` unknown / `○` other key (purple when one holds it), plan `new key` green / `cut off` red (`*` = changed from the default), step marks `✓ · ·` in cyan (`✗` red on the failed step); the walk is a progress bar `███░░ 3/8 done`, the current project's steps (`✓` green, `❯` orange = next, `·` dim), "up next", then the log. Two-press arms (start, finish, batch revoke) turn the border red and the status line names what happens; `--simulate` turns the border yellow.

**Check the width before adding a glyph.** `⚡` and `＋` are double-width and push the rest of a fixed-width line off its right edge — `⚡` cost the command card its badge; `☰` measured two cells in the review picker and shoved the badge column (use `≡`). If in doubt, render it in a card and count cells.

## States

- Loading: dim text (`scanning project...`) or spinner-prefixed event line in yellow.
- Long ops: append-style event log — done steps `✓` dim, current step spinner+yellow, final `✓` green / `✗` red; optional ProgressBar when pct is known.
- Empty: dim one-liner with the reason and the fix ("No pgbackup-*.zip files here — run a backup first").
- Destructive: red `⚠` warning + type-to-confirm input whose border goes green when the text matches.

## Voice / copy

Lowercase panel titles (` pg backup `). Hints terse and lowercase ("kill & back"). Messages state the thing + the next action, no exclamation marks. Sentence case for content lines.

## Don'ts

- ❌ Inline hex colors — add to `T` first if genuinely new.
- ❌ `<select>` from opentui for menus — `ListPicker` is the one list; consistency of caret/badge/mouse behavior depends on it.
- ❌ A screen without a `Footer` — every screen advertises its keys.
- ❌ More than one accent per screen title / rainbow event logs.
- ❌ Blocking the first paint — heavy work happens after mount, behind a spinner.
- ❌ Emoji icons — single-cell unicode glyphs only (emoji are double-width and misalign columns; the menu's `🖳` proved it and was replaced with `⌂`).
- ❌ Content-sized boxes anywhere the content changes — see Painting.
