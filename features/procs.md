# Claude procs

**Status:** shipped 2026-10-05 · `destedtui --procs`, shell `procs`, menu tile "Claude procs"

## Why

Sal runs dozens of Claude Code sessions at once. They leave dev servers running in duplicate, `nohup` jobs, Monitor `tail | grep` watchers, headless browsers and bx daemons behind, and the PC slows down with no way to tell which session did it. This screen answers "what is eating my machine, which agent started it, and can I kill it".

## What it shows

- **Summary line:** the whole machine's CPU (sum of every process's rate over the core count), then what the listed units add up to.
- **Session groups:** one per CLI `claude.exe`, named from `~/.claude/sessions/<pid>.json`, plus the label from Sal's status card (`~/.sal/status/<project>/<session>.json`). The rows under it are units: each direct child subtree of that claude (Bash-tool shells, background jobs, servers).
- **Orphan groups (per project):** dev processes whose launcher is gone. The unit root is found by climbing through launch wrappers (`bash -c`, `cmd /c`, `nohup`, node/bun); if that root's parent is dead, it's an orphan.
- **Outside claude:** dev processes under a living non-Claude parent (your terminals, the editor).
- **Unit flags:**
  - `hot`: smoothed load of at least 0.5 cores.
  - `×N`: N units share the same command line in the same folder.
  - `daemon`: detached on purpose (`daemon`, `proxy start`).
  - `mcp`: an MCP server.
  - `bg`: started from that session's scratchpad (`…\Temp\claude\<proj>\<session-id>\`) and then detached, so it's still attributed to the session.
  - `old`: older than 24h.
  - `svc`: parent is `services.exe`.

## Kills

All kills take two presses. The first press arms (red ✕?, and the status line says what dies); a second press within 3s fires. Each kill is one batched `taskkill /T /F /PID …` run off the UI thread.

- **Row ✕:** kills that unit's tree, whatever it is.
- **Group `✕ all`:** kills every unit in the group except mcp, daemon and service units. It never kills claude itself.
- **`✕ orphan leftovers` (bar, shift+x):** kills orphans that have no listening port and aren't daemons, such as dead sessions' watchers, headless browsers and one-off scripts. A listening orphan may be a server you're still using, so those are killed one row at a time.

## Limits

- Windows only (bun:ffi, the same scanner as localhost).
- Subagents run inside their lead's process, so their work shows under the lead session.
- "Orphan" means the parent is gone, not that nobody is using it. Read the row before killing a server.
