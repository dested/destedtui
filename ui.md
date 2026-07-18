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

Accent discipline: each screen owns one accent for its border title (`titleColor`) — menu purple, scripts green, backup blue, restore orange, process cyan. Status colors are earned by state, never used for decoration.

## Layout

Every screen = same shell: `Header` (ascii-font "DESTED" gradient purple→blue→cyan + cwd right) → one rounded-border panel (`margin: 1, marginTop: 0, padding: 1`, `backgroundColor: T.panel`, titled ` lowercase name `) → `Footer` hint bar. The panel border turns `T.green`/`T.red` on terminal success/failure states.

## Components

| Component | File | Purpose |
| --- | --- | --- |
| `Header` | `src/components/Header.tsx` | brand row; takes `subtitle` (cwd) |
| `Footer` | `src/components/Footer.tsx` | hint bar; `hints: [key, label][]`, key in cyan, label dim |
| `ListPicker` | `src/components/ListPicker.tsx` | ALL lists: `❯` caret, icon, title, dim subtitle, right badge, disabled rows, windowing with `▲/▼ N more`, mouse click |
| `ProgressBar` | `src/components/ProgressBar.tsx` | flat block bar + dim percent |

Signature row (ListPicker item): `❯ ▶ title  dim-subtitle` … `badge` — icons are single unicode glyphs (▶ ⛁ ↺ ⎇ ⚡ ☰ ✕ ◈ ⚠ ＋).

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
- ❌ Emoji icons — single-cell unicode glyphs only (emoji are double-width and misalign columns).
