# Memory leak: 68 GB of commit from one long-running TUI

Status: active

## What happened

- On 2026-10-07, one `bun …\destedtui\src\index.tsx` process (PID 28716, no flags,
  so the picker auto-launch, then whatever screen Sal left it on) had been up for
  about 13.5 h. It held **68.6 GB private commit with a 2.8 GB working set**.
- Windows hit 0 GB free commit out of 192 GB. Event `Resource-Exhaustion-Detector
  2004` fired at 11:41:00 and named it. The WSL VM was killed twice, a Claude Code
  session died, and PowerShell crashed with "Releasing the double mapped memory
  failed".
- **Rate:** about 5 GB/h, or about 1.4 MB/s. Commit far above the working set means
  memory is allocated, touched once, never freed, and then trimmed to the
  pagefile. It's a real leak, not caching.

## Suspects (ranked)

1. **`new TextDecoder("utf-16le")` per process per scan.**
   - `snapshot()` constructs one per process entry, and `readUnicodeString()` one
     per cmdline/cwd read.
   - Ports and Procs scan every 2 s (`SCAN_MS = 2000`), about 500–1000 decoders/s
     on a box with this many processes.
   - Each one carries a native codec that the GC doesn't account for. About 1.4
     MB/s divided by about 250–700/s is 2–6 KB each, which is right for an ICU
     converter.
   - Fix: one module-level decoder.
2. **OpenTUI re-renders driven by spinners that never stop.** Many screens run
   `setInterval(setFrame, 90–120 ms)` even when idle. That's 8–11 renders/s, or
   about 400k over 13.5 h, which works out to roughly 170 KB/render if the Zig core
   (`@opentui/core` 0.4.3) leaks per frame.
   - Fix: only tick while something is actually loading, and upgrade or report
     upstream if the core leaks.
3. **Per-scan FFI typed arrays plus `ptr()`.** `inspect()` allocates about 4 small
   arrays per process per scan, plus the `GetExtendedTcpTable` buffer. Check
   whether Bun pins or leaks `ptr()`'d buffers on Windows.
   - Fix: preallocate and reuse per scan.
4. **ClaudeUsage rescan** (`RESCAN_MS = 2 min`) re-parsing the ~16 MB usage cache
   and transcripts. That would show up as allocator fragmentation: commit growing
   in steps while the heap stays flat.
5. **`term` panes.** `@xterm/headless` scrollback and the ptyhost line buffers.
   Bounded? It's only a suspect if a long Claude pane was open.

(Handles are fine: `inspect()` and `snapshot()` close in `finally`, and
`detailCache` is pruned.)

## Findings 2026-10-08 (step 2 run, from the bx-monitor session)

- `processTable()` ×1000 leaked **347 KB of private commit per scan**, with the JS
  heap flat at 25 MB. On 561 processes that's about 620 B per process.
- Every FFI call measured flat in isolation once the heap had warmed:
  OpenProcess/CloseHandle, GetProcessTimes, K32GetProcessMemoryInfo,
  NtQueryInformationProcess, ReadProcessMemory with BigInt args, and
  GetExtendedTcpTable. The Toolhelp walk was about 1.8 KB per walk, which is
  noise. So suspect 3 is cleared.
- **Suspect 1 was half right.** The leak is `TextDecoder("utf-16le").decode()`
  itself: about 670 B per call on a 520-byte name, and the same with a shared
  decoder or a fresh one. Hoisting the decoder fixes nothing. UTF-8 `TextDecoder`,
  `Buffer.toString("utf16le")` and a manual loop all measured flat (Bun 1.3.10,
  Windows).
- **Fixed** in `lib/ports.ts`: `utf16()` goes through `Buffer`. Re-run: −19 KB per
  scan, which is noise. Names, cwd and cmdline decode the same.
- **This doesn't account for all of the incident.** One scanning screen at 2 s
  leaked about 175 KB/s, or about 0.6 GB/h. The incident ran at about 5 GB/h, so
  suspects 2, 4 and 5 are still open. Steps 1 and 3 (`--memlog`, bisect by screen)
  are the next move.
- `keys/win32.ts` still decodes the clipboard with `TextDecoder("utf-16le")`. It's
  one call per `keys add`, so harmless, but swap it if you're in there.
- Side note: the Toolhelp walk takes about 63 ms of each 72 ms scan, on the UI
  thread every 2 s. `NtQuerySystemInformation(SystemProcessInformation)` would get
  names, ppids, times and memory counters in one call.

## 2026-10-10: the idle pause caps the damage

The leak is still open, but a TUI now lives at most a minute idle: the bins
are Node launchers that restart the Bun process (decisions.md 2026-10-10). A
leak only grows while someone is actively using a screen, or while one is held
awake (term panes, dev servers).

## Steps

1. **Measure first.** Add a hidden `--memlog` flag that appends every 15 s to
   `~/.destedtui/mem.log`: own private commit (`K32GetProcessMemoryInfo` →
   `PagefileUsage`, offset 56), `process.memoryUsage()` (rss, heapUsed,
   external, arrayBuffers), and the current route.
2. **Cheapest discriminator, no TUI.** A script that calls `processTable()` /
   `scanServers()` 2000× in a loop and prints the commit delta. Then the same with
   a single shared `TextDecoder`. If suspect 1 is right, the leak vanishes. About
   10 minutes total.
3. **Bisect by screen.** Run 10 minutes each on the picker (idle), Ports, Procs,
   ClaudeUsage, Keys and `term` with one pane, using `--memlog`. Any leak at
   1.4 MB/s shows up within a minute.
4. **Fix the guilty one(s)** per the suspect list. Hoist the decoders regardless:
   it's free.
5. **Guardrail.** If own commit goes over 2 GB, log it and show a one-line warning
   in the footer. A slow leak should never again be discovered by Windows killing
   WSL.
6. **Add a soak recipe to `verify.md`** (`[heavy — ask first]`): 30 minutes per
   polling screen with `--memlog`. Pass means less than 50 MB/h of commit growth.

## Done when

- Every polling screen grows less than 50 MB/h over 30 minutes.
- An overnight run on Procs (the most likely screen to be left open) stays under
  1 GB of commit.
- `bun x tsc --noEmit` is clean, and an `updates.md` entry is written.
