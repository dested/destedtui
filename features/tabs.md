# Tabs

**Status:** shipped 2026-10-16 · bin `tabs`, shell `save-sessions <name>` / `restore-sessions [name]` (pwsh + zsh)

## Why

Sal runs ~18 Windows Terminal tabs, nearly all Claude Code sessions, some on Windows (pwsh → claude.exe) and most in the `sal` WSL distro (wsl.exe → zsh → claude). A reboot kills them all. `tabs save <name>` records what each tab of one window was running; `tabs restore` reopens the ones he ticks, in order, in the window he runs it from.

## CLI

| Command | What it does |
| --- | --- |
| `tabs` | the TUI: snapshot list → tab list |
| `tabs save <name>` | capture the window you run it from; prints a table of the tabs and the saved path; overwrites (says "replaced") |
| `tabs restore [name]` | TUI on that snapshot (no name: the list first) |
| `tabs restore <name> --all` | no TUI: every claude + shell tab, no apps, no missing transcripts |
| `tabs restore <name> --dry-run` | print each tab's `new-tab` args and the whole `wt` command (the `--all` set) |
| `tabs list [--json]` / `tabs show <name> [--json]` / `tabs rm <name>` | the store |

`--hwnd <n>` (hidden, `save` only) captures that window instead of the foreground one: testing from a tab in another window. In WSL the `tabs` bin forwards to `tabs.exe` (`forwardToWindows`), passing its pts as `TABS_SELF_TTY`. Exit codes: 0 ok, 1 user error, 2 saved with warnings (a title may not have gone back).

## Store

`G:\code\sals-powershell-setup\claude\sessions\<name>.json` (gitignored in that repo; `TABS_DIR` overrides). Zod `SnapshotSchema` in `src/lib/tabs/store.ts`, `version: 1`, validated on every read. Each tab: `index`, `title` (leading status glyphs stripped: `🔔 clever` → `clever`), `rawTitle`, `platform` (`windows` | `wsl`), `cwd` (Windows path or `/w/code/...`), and by `kind`:
- `claude`: `sessionId`, `sessionName`, `lastPrompt` (the newest prompt a person typed, first 160 chars)
- `app`: `command` (Windows: the process's command line; WSL: argv, shell-quoted)
- `shell`: nothing more

## Capture (`src/lib/tabs/capture.ts`)

Windows Terminal doesn't say which process is in which tab, so each pane is given a unique title and the tab titles are read back.

1. Target = `GetForegroundWindow()`, class `CASCADIA_HOSTING_WINDOW_CLASS`, else "run this from a Windows Terminal tab". Its owner pid is the WindowsTerminal.exe.
2. Tab titles, in order, from UI Automation: `scripts/tabs-uia.ps1` (every WT window, `TabItem` names, JSON).
3. Pane roots = that WindowsTerminal.exe's children minus OpenConsole.exe (`processTable()`).
4. Read every root's console title and stamp the non-WSL ones with `§tabs-<token>-<pid>` (`scripts/tabs-console.ps1`: FreeConsole → AttachConsole → Get/SetConsoleTitle; spawned `windowsHide` so it never touches our own console).
5. WSL: one `wsl.exe -d sal --exec bash -s` lists every pts whose session leader is a shell (pid = sid), with its foreground process (tpgid), cwds, argv and `~/.claude/sessions/<pid>.json`, and writes OSC 0 `§tabs-<token>-pts<N>` to each pts.
6. 300 ms, read UIA; one more look after 600 ms for any marker still missing (a busy claude retitles its tab).
7. Always (finally): WSL pts not seen on any tab get an empty OSC title; then every pane root's console gets its exact prior title back. That covers inactive splits too.
8. Map: our own pane (an ancestor root, or `TABS_SELF_TTY`) is set aside as "this tab". Windows pane: the shallowest `claude.exe` descendant with an interactive session file → claude (session cwd, transcript under `~/.claude/projects/<cwd, non-alnum → ->/<id>.jsonl`); else the newest child that isn't conhost/oh-my-posh → app; else shell (cwd from the PEB). WSL pane: foreground = shell → shell; foreground has a session file → claude (transcript read over `\\wsl.localhost\sal\home\dested\.claude\projects`); else app (`/proc/<pid>/cmdline` + cwd).

`lastPrompt` (`src/lib/tabs/transcript.ts`) scans the transcript tail (512 KB, then 4 MB, then 16 MB) for a `type:user` line that isn't a tool result, `isMeta`, a compaction summary, a teammate message, or text starting with a tag (`<system-reminder>`, `<command-…>`, …). Pastes become `[paste]`.

## Restore (`src/lib/tabs/restore.ts`, `src/screens/Tabs.tsx`)

One `wt -w 0 …` call, `new-tab` per tab in saved order, separated by `;` (a literal `;` in an argument becomes `\;`):
- windows claude: `new-tab --title <t> -d <cwd> pwsh -NoExit -Command "claude --resume <id>"`
- windows shell: `… pwsh -NoExit`; windows app: `… pwsh -NoExit -Command "<command>"`, or `-EncodedCommand` when the command holds `"`, `` ` `` or `;` (a quoted exe path gets `& ` in front)
- wsl claude: `new-tab --title <t> -p sal wsl.exe -d sal --cd <cwd> --exec env "SAL_RUN=claude --resume <id>" zsh -l` (the zshrc runs SAL_RUN once, then stays interactive; same form as `claude-sessions.ps1`)
- wsl shell: the same without SAL_RUN; wsl app: `SAL_RUN=<command>`. WSL commands are joined with POSIX quoting that never emits `"` or `;` (awkward args go in `$'…'` with hex escapes), so they survive WT's and wsl.exe's own parsing.

Ticks: claude and shell rows default on, apps off ("ask per app"), a claude row whose transcript is gone shows "⚠ transcript missing" and defaults off. An unticked app still opens as a plain shell in its cwd; unticked claude/shell rows don't open. Click or space ticks a row, `a` (or the bar button) flips every app, enter restores and exits with "✓ restored N tabs".

## Limits

- Windows Terminal only, one window per snapshot. Panes in inactive splits, and tabs Sal renamed (a fixed title ignores the marker), are skipped and reported.
- A WSL pts that isn't a Terminal tab (an editor's terminal, tmux) gets the marker and then an empty title.
- On Linux plain `tabs` is also ncurses' `/usr/bin/tabs`; `~/.bun/bin` comes first on Sal's PATH, and the zsh functions call `~/.bun/bin/tabs` by path.
