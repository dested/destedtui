# Pull to Local

> Status: **done** · Last updated: 2026-07-18

## What / Why

One-shot "clone a remote/`.env` database into localhost." Pick a discovered database, name the local copy, and it dumps the source and restores it straight into your localhost server — **no intermediate zip** to create or clean up. The daily "pull prod into local dev" button.

## Behavior spec

- Flow: `pickdb` (discovery DB list = sources) → `connectlocal` (list local DBs to know what exists) → `typetarget` (local DB name; **empty enter = same name as source**) → if that name exists locally: `confirm` (typed-name → overwrite); else create new → run.
- Run (`lib/pull.ts` `startPull`): detect source server + target server → `ensureTools` for the source major (dump) and target major (restore; reused if same) → `pg_dump -Fc` source to an OS-temp archive (size polled for progress) → create or drop+recreate the target DB → `pg_restore --no-owner --no-acl` into it → delete temp.
- Done screen prints the masked local URL. Non-zero `pg_restore` exit → "finished with warnings" (harmless ownership notices). Esc cancels (kills the running tool) and steps back.
- Needs the localhost connection preset (`lib/pglocal.ts`); a local-connect failure points at the Local Postgres screen. Requires ≥1 discovered `DATABASE_URL` (tile disabled otherwise).
- `--pull` jumps straight here.

## Touchpoints

| Part | File |
| --- | --- |
| Dump→create→restore orchestration | `src/lib/pull.ts` |
| Server detect / tools | `src/lib/pgtools.ts` |
| Localhost conn + DB list | `src/lib/pglocal.ts` |
| UI | `src/screens/Pull.tsx` |

## Edge cases

- Source and target different majors → dump uses source-major tools, restore uses target-major tools (both auto-downloaded/cached).
- Overwriting a local DB with live connections → backends terminated before drop.
- Temp archive always deleted in `finally`, even on cancel/error (best-effort if file-locked).

## Open questions

- [ ] No selective/table-subset pull — whole database only. Add filters if needed.
- [ ] No anonymize-on-restore step yet (scrub PII after pull) — deferred from the original brainstorm; revisit if pulling real prod data locally.

## How to verify

[heavy — ask first] Covered by the smoke test in `verify.md` (pull new + pull overwrite vs live PG 18.3, row counts asserted).
