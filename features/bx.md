# bx daemons

**Status:** shipped 2026-10-08 · `destedtui --bx` (`--log` starts the memlog), shell `bxtop`, menu tile "bx daemons"

## Why

Sal's Claude sessions drive Chrome through bx (G:\code\bx): one Node daemon per profile, each with its own Chrome. A dozen of them run at once, some for hours, and the machine runs out of commit. This screen shows every daemon, what it's doing, who is driving it and which one is growing, plus the leftovers that outlived their daemon. From the same screen you can stop or kill any of them, force a gc, or take a heap snapshot.

## Data

- **Discovery:** `~/.bx/run/<profile>.json` (pid, port, token, startedAt) plus one `processTable()` scan from `lib/ports.ts`, every 2s.
- **Inside a daemon:** `GET /debug` on the daemon (bx `src/daemon/debug.ts`). It returns node memory, CPU, event-loop delay, every command in flight, the last 200 commands with duration and error, per-verb totals, the clients that sent them (Claude session id, cwd, verb), action-log and ref-registry sizes, and per-tab CDP metrics (JS heap, DOM nodes, listeners, documents, frames). Parsed with zod in `lib/bx.ts`. A 404 means the daemon predates /debug ("old daemon"). Reading /debug doesn't count as activity, so watching never keeps a daemon past its idle exit.
- **Chrome:** the daemon's process tree (node → chrome → renderers, gpu, utility), summed, each process labelled by `--type`.
- **Who's driving:** each client's Claude session id resolves to that session's status-card label (`~/.sal/status`), else its Claude name (`~/.claude/sessions`), else its folder. A CLI run from a plain terminal shows as "terminal".
- **History:** 30 min per daemon in memory (tree commit and working set, node RSS and heap, Chrome commit and working set, and per-tab heap, nodes and listeners). Growth is a least-squares slope over the last 5 min, and needs at least 60s of data.

## What it shows

- **Summary line:** daemon count, how many are busy, total commit (or working set), orphan count.
- **Daemon rows (2 lines):**
  - Line 1: state glyph, profile, state, uptime and a `■ stop` row button. The states:
    - `●` yellow: a command is in flight, with its elapsed time and summary.
    - `◉` red: recording.
    - `●` green: idle, with how long.
    - `○`: no browser open.
    - `◌` orange: old daemon.
    - `✕`: not answering.
  - Line 2: node and Chrome memory, the process count, a trend sparkline (up to 10 min, adaptive while history is short), growth per minute (dim when flat, yellow from 1 MB/min, red from 10 MB/min), CPU as % of one core, and "by <driver>".
- **Orphan rows (⚠):**
  - A daemon process with no run file.
  - A bx Chrome (`--user-data-dir` under `~/.bx/profiles`) whose daemon is gone.
  - A run file whose pid is dead or reused.
- **Detail pane** (side pane when the terminal is at least 120 cols wide, else it replaces the list). Views 1–5:
  - `overview`: state, idle-exit countdown, drivers, the memory table with sparklines and slopes, CPU and event loop p99, command totals, and internal sizes (action log, refs, console and network rings, whether gc is exposed).
  - `pages`: one block per tab, with URL, JS heap, DOM nodes and listeners (each with a trend and slope), documents, frames, refs, layouts and script time.
  - `activity`: in-flight commands first, then recent ones newest first, with clock time, ms, ✓ or ✗, summary and tab or driver (or the error).
  - `procs`: the process tree with pid, working set, commit and CPU.
  - `log`: the tail of `~/.bx/logs/<profile>.log` with ANSI stripped, failures in red.

## Actions

Every kill takes two presses: the first arms it and the status line names what dies, and a second press within 3s fires.

- **Row `■ stop` / `x`:** POSTs `/shutdown` with the token, so Chrome closes cleanly. If that fails, it kills the tree with `taskkill /T /F` and removes the run file.
- **Orphan row `✕` / `x`:** kills the orphan's tree, or deletes a stale run file.
- **`✕ orphans (n)` / `shift+x`:** cleans up every orphan.
- **`✕ kill tree` / `k`:** `taskkill /T /F` on the daemon. Use it when /shutdown hangs.
- **`⟳ gc` / `g`:** POST `/debug/gc`, a full collection (the daemon runs with `--expose-gc`). Reports heap before and after.
- **`⛁ heap snapshot` / `h`:** POST `/debug/heapsnapshot`, written to `~/.bx/heaps/<profile>-<ts>.heapsnapshot`. Load it in Chrome DevTools → Memory. It takes seconds and briefly doubles the heap.
- **`⏺ memlog` / `l`:** appends one JSON line per daemon per scan to `~/.destedtui/bx-memlog/<date>.jsonl`. Use it for overnight trend capture.
- **`mem` seg / `m`:** commit (private bytes, the leak metric) or working set (what Task Manager shows).
- **`⛁ profiles` / `p`:** opens the profiles screen (below). Once it has measured every profile, the button carries the total, e.g. `⛁ profiles 40G`.

## Profiles screen

`~/.bx/profiles` holds one Chrome user-data-dir per profile name, and bx never deletes them: 460 folders, 40 GB on 2026-10-08. This screen (`BxProfiles.tsx`) is where they get cleaned up.

- **Sizing:** a Bun Worker (`lib/bxProfilesWorker.ts`) walks every folder, about 25s for all of them. Rows fill in as each one is measured. The sizes stay cached for the session, so coming back paints at once while a fresh scan runs.
- **Rows:** `○` (or teal `●` when in use), name, size (dim under 100M, then fg, yellow from 500M, red from 1G), last used and status, plus a `✕ delete` row button. In-use rows show `in use` instead.
- **Last used:** the newest mtime of Chrome's `Local State`, `Default/Preferences`, the folder itself and `~/.bx/logs/<name>.log`. It's orange when older than the `unused ≥` setting.
- **In use:** a live daemon, an orphaned Chrome, an orphaned daemon, or a stale run file, from the same scan as the bx screen, every 3s. In-use profiles can't be deleted. The worker also refuses any profile whose run file exists.
- **Detail strip:** the path and file count, the six biggest top-level entries, last used with the date, and the size of the bx log.
- **`✕ delete` / `x` (two-press):** removes the folder and its bx log. Cookies, logins and cache go with it, and the next `bx --profile <name>` starts fresh.
- **`✕ prune N · size` / `shift+x` (two-press):** deletes every profile unused for at least `1d`, `7d` (the default) or `30d`. It's only enabled once every profile has been measured. It never touches `default` (bx's own default, the one a person signs into) or anything in use.
- A delete reports what it freed. If something still holds files in a folder, it's reported as partly deleted and that folder is measured again.
- **Sort:** size (default), age (oldest first) or name. Keys: `s` cycles sort, `a` cycles the age, `r` rescans.

## Limits

- Windows only (the `lib/ports.ts` scanner).
- Daemons from before 2026-10-08 have no /debug. Their row shows memory and CPU from the process scan only. Stop one and the next bx command spawns a new daemon with /debug.
- Per-tab metrics come from CDP `Performance.getMetrics`, with an 800ms timeout per tab. A tab busy in a long task shows `—` for that scan.
- History lives in memory and is gone on quit. Use `--log` for anything longer.
