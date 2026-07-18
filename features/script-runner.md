# Script Runner

> Status: **done** · Last updated: 2026-07-18

## What / Why

Finds every `package.json` script in the tree under the cwd (monorepo-aware) and runs the one you pick with the right package manager, streaming output live. Exists so dested never hunts through workspace folders for `dev`/`build` commands.

## Behavior spec

- When destedtui boots, it walks the cwd (depth ≤ 4, skipping node_modules/.git/dist/build/out/.next/.turbo/.cache/coverage/target/vendor and dot-dirs) and collects every `package.json` that has a non-empty `scripts` object.
- Each package's manager is detected from the nearest lockfile walking up to the scan root (bun.lock/bun.lockb → bun, pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm; default bun).
- The Scripts screen shows one flat list: script name, package name + relative path, truncated command, PM badge (color-coded). Typing filters (prefix > substring-in-script > substring-in-package > subsequence); ↑↓ selects; enter or mouse-click runs.
- Running opens ProcessView: `cmd.exe /d /s /c "<pm> run <script>"` (sh -c off-Windows) in the package dir with `NO_COLOR=1`, stdout/stderr streamed as lines (stderr tinted orange), batched to state every 80ms, capped at 4000 lines.
- While running: spinner + elapsed seconds; `ctrl+x` kills the process tree (taskkill /T /F); `esc` kills and goes back. After exit: `✓ done in Ns` (green border) or `✗ exit N` (red border); esc back.
- When the app quits (q/ctrl+c), all spawned processes are tree-killed (`killAll`).

## Touchpoints

| Part | File |
| --- | --- |
| Discovery | `src/lib/discovery.ts` |
| List + filter UI | `src/screens/Scripts.tsx` |
| Spawn/kill/stream | `src/lib/run.ts` |
| Output UI | `src/screens/ProcessView.tsx` |

## Edge cases

- Unparseable package.json or unreadable dir → silently skipped.
- Filter with no matches → dim "No scripts match"; no packages at all → explains none were found.
- Output beyond 4000 lines → oldest lines dropped (memory cap).
- ANSI escapes in output → stripped (`ANSI_RE`).

## How to verify

[cheap] In this repo: `destedtui` → Scripts → run `typecheck` → expect streamed output then green `✓ done`.
