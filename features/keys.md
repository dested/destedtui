# Keys — one vault for every AI API key

> Status: shipped 2026-10-03 (overnight build); usage, Drydock and rotate 2026-10-04. Spec: `plans/2026-10-03-keys.md`.

## What it does

Holds every AI API key Sal uses, **one per project per provider**, in a DPAPI-encrypted
vault. Mints keys through the provider's admin API where one exists; otherwise opens the
console page and takes the key off the clipboard, so a secret never passes through argv or
a Claude transcript. Writes each project's keys into its gitignored `.env`. Finds keys
already sitting in `.env` files and reports the ones reused across projects.

Surfaces: the third global bin `keys` (CLI first — Claude sessions drive it), the Keys
screen (`keys` with no args, `destedtui --keys`, the menu tile, typing `keys` in the
picker), the `keys` Claude skill (`skill/keys/SKILL.md`), and PowerShell's `Use-Keys`.

## Files

| Piece | Path |
| --- | --- |
| CLI bin | `src/keys.tsx` |
| Screen | `src/screens/Keys.tsx` |
| Operations shared by CLI + screen | `src/lib/keys/ops.ts` |
| Vault (zod schema, DPAPI read/write, lock, backups) | `src/lib/keys/vault.ts` |
| DPAPI + clipboard via bun:ffi | `src/lib/keys/win32.ts` |
| Built-in providers | `src/lib/keys/providers.ts` |
| Mint adapters (one file each) + registry | `src/lib/keys/adapters/*.ts`, `adapters/index.ts` |
| `.env` upsert/remove + gitignore check | `src/lib/keys/envfile.ts` |
| `.env` scanner for `keys import` | `src/lib/keys/importer.ts` |
| Drydock client (tRPC) / app→folder map + env fingerprints / push | `src/lib/keys/drydock.ts`, `deployed.ts`, `push.ts` |
| Rotate flow + dead-key batch / screen | `src/lib/keys/rotate.ts`, `src/screens/KeysRotate.tsx` |
| Project activity (Claude history + reflog) / cheap auth checks | `src/lib/keys/activity.ts`, `verify.ts` |
| Headless frames of the Keys screens | `scripts/snap-keys.tsx` |
| Claude skill (junctioned to `~/.claude/skills/keys`) | `skill/keys/SKILL.md` |

## Data

`~/.destedtui/keys/vault.bin` = `CryptProtectData(JSON)`, CurrentUser scope, no master
password. Written atomically (temp + rename) under `vault.lock`; the previous five versions
are kept as `vault.bin.1..5`. `KEYS_VAULT_DIR` overrides the folder (tests).

- `providers[]` — `id, name, envVar, aliases[], prefixes[], consoleUrl, mint?, builtin`.
  Built-ins are refreshed from code on every load; custom ones persist.
- `keys[]` — `id (k_xxxxxxxx), providerId, project, label, value, fingerprint, createdAt,
  source (minted|pasted|imported), remoteId?, revokedAt?, envFile (default .env), envVar?`.
  `envFile`/`envVar` remember where an imported key really lives (`web/.env`,
  `VITE_OPENAI_API_KEY`) so `keys env` writes it back to the same place.
- `drydock.overrides` — Drydock app → folder (`-` = not a local project).
- `rotations[]` — `id, fingerprint, providerId, status (walking|finished|abandoned),
  projects[{project, plan (new|cutoff), apps[], keyId?, created?, env?, pushed?, verified?{ok},
  error?}], revoked?{remote: revoked|console, note}`. The walk's durable state.
- `admin[]` — `providerId, value, fingerprint, createdAt, meta{}`. Never written to a `.env`.
  When the vault has none, the adapter's user env var is used (`OPENAI_ADMIN_KEY`,
  `ANTHROPIC_ADMIN_KEY`).

Fingerprint = first 12 hex of sha256(value). It is the only thing any list shows.

## Rules the code enforces

- A second active key for (provider, project) is refused unless `--replace`, which revokes
  the old one (remote when possible).
- `add` refuses a value that is already another project's active key.
- Remote revoke is **skipped** when the same value is still active in another project
  (it would break them); the key is marked revoked locally and the reason is printed.
- A mint whose store fails is revoked again, so nothing exists remotely that the vault
  doesn't know about.
- `.env` writes preserve every other line, comment and line ending; `revoke` removes a line
  only if it still holds the revoked value. `.env` is added to `.gitignore` when
  `git check-ignore` says it isn't ignored; a committed `.env` is flagged loudly.
- `reveal <id>` prints the value and copies it; `copy <id>` only copies. Inside Claude Code (`CLAUDECODE` set) reveal copies without printing. The screen's ⧉ row button (`c`) copies and shows the value in the status line. `values` still needs `--yes-print-secret` and refuses inside Claude Code.
- Exit codes: 0 ok, 1 user error, 2 provider/API error.

## Provider admin APIs (researched 2026-10-03, docs fetched that night)

| Provider | Can mint? | How | Revoke |
| --- | --- | --- | --- |
| OpenAI | **yes — verified live** | `POST /v1/organization/projects/{p}/service_accounts` with an Admin key; project = meta `projectId` → one named like the Sal project → "Default project" | `DELETE …/service_accounts/{id}` |
| ElevenLabs | yes, on multi-seat plans | `POST /v1/service-accounts/{sa}/api-keys {name, permissions:"all"}`; service accounts are multi-seat + workspace-admin only. Sal's plan is `creator`; `GET /v1/service-accounts` answers 200 with 0 accounts — minting is unproven | `DELETE …/api-keys/{key_id}` |
| xAI | yes | Management API `POST /auth/teams/{team}/api-keys` with ACLs `api-key:endpoint:*`, `api-key:model:*`; team from `/auth/management-keys/validation` | `DELETE /auth/api-keys/{id}` |
| OpenRouter | yes | `POST /api/v1/keys {name}` with a Management API key → `key`, `data.hash` | `DELETE /api/v1/keys/{hash}` |
| fal | yes | `POST https://api.fal.ai/v1/keys {alias}` with an ADMIN-scope key (`Authorization: Key …`) → `key` (`id:secret`) | `DELETE /v1/keys/{key_id}` |
| Anthropic | **no** | Admin API has list / retrieve / update only — no create | archive (`POST /v1/organizations/api_keys/{id} {status:"archived"}`); `locate` finds a pasted key's id by `partial_key_hint` |
| Google Gemini | no | API Keys API needs GCP OAuth — out of scope | console |
| Groq | no | no documented key API | console |
| Replicate | no | tokens are dashboard-only | console |
| TypeSafe (Jev) — `typesafe`, alias `jev` | no | no key-management API in docs.typesafe.ai (2026-10-06); env var `TYPESAFE_API_KEY` per the SDK constants | console (`console.typesafe.ai/keys`) |

Adding an adapter: one file in `src/lib/keys/adapters/` exporting a `MintAdapter`
(`mint`, `revoke`, optional `locate`) + one line in `adapters/index.ts` + `mint: "<id>"` on
the provider.

## Screen

Rows grouped by project (or provider — the `group` control), each: provider/project, id, fingerprint,
source, file + var, a red `⚠ same key in N projects`, and row buttons `.env` / `↗` / `✕`.
Action bar: `+ new key` (mint), `⧉ paste key` (add from clipboard), `$ usage`, `↻ rotate`,
`⇣ import .env keys`, `group project | provider`, `+ provider`, `⚿ admin key` (admin credential
from clipboard); `← back` flush right. Row `✕` revokes (two-press, panel border red, status
line says local-only vs remote). Forms replace the list (CommandEditor pattern) and swap the
bar for `✓ go` / `⧉ read clipboard` and `✕ cancel`; a click focuses a field, and a choice
field steps with its `‹ ›` (or a click on the value). Letter keys (`n a w o x i p m g u R`)
remain silent aliases.

## Usage (2026-10-04)

"Which of my projects are spending right now." `keys usage [--project p] [--provider x]
[--days n] [--refresh] [--json]` and the Usage view on the Keys screen (`$ usage`). Nothing in the
morning brief or sal-agent (Sal's call).

**Owners, not keys.** Providers report usage per provider-side key. Each key is matched to
vault records, and the line it lands on is its owner:

| Owner | When | Shown as |
| --- | --- | --- |
| project | the value is live in exactly one project | the project name |
| shared | the value is live in N > 1 projects | `⚠ shared × N: a, b, c` in red — **never credited to any one project**; the detail strip says to give each its own key |
| unmatched | a provider key the vault doesn't know (deleted, ephemeral like openai-image's, made in a console) | `<provider> · "<name>"`; ephemeral names collapse (`claude-imggen-ephemeral-*`), deleted keys group as `deleted keys (no longer listed)` |
| account | usage credited to no key (web app, console, playground) | `<provider> · account (no key)` |

`--project p` lists the lines that include p (its own line and every shared group it's in)
with a per-key breakdown.

**Columns.** 24h≈, today, N days (default 7), an N-day sparkline (`▁▂▃▄▅▆▇█`, `·` = nothing),
providers, last used. Dollars where the provider reports cost; raw units otherwise (only
when no provider on the line reports $). Sorted by 24h spend, then today, then the window, so
what's burning now is on top. **24h is an estimate**: providers bucket by UTC day, so it's
today + the part of yesterday still inside the last 24 hours.

**Cache.** `~/.destedtui/keys/usage.json` (plain JSON, `usage/cache.ts`, zod on read). No
secrets: provider key ids and names, vault key ids, numbers. A read older than 15 minutes
(or covering fewer days than asked) refetches; `--refresh` / `↻ refresh now` forces it; the screen also
refetches every 15 minutes while open. All providers fetch in parallel; one failing becomes
a status line, never a failed run.

**Providers** (verified against docs 2026-10-04; "live" = called for real tonight)

| Provider | Scope | How | Match to vault | Evidence |
| --- | --- | --- | --- | --- |
| OpenAI | per key, $ | `GET /v1/organization/costs?group_by[]=api_key_id` (1d) + `GET /v1/organization/projects/{id}/api_keys` for names, `redacted_value`, `last_used_at` | redacted value (prefix + last 4; ambiguous ⇒ no match) | **live**: 200, 9 daily buckets, ~90 key-days; 9 keys listed |
| ElevenLabs | per key, $ + credits | `POST /v1/workspace/analytics/query/usage-by-product-over-time` `group_by: ["hashed_xi_api_key"]`, daily → `total_cost` (usd), `total_usage` (credits), `api_key_name` | by **name** only: the hash isn't sha1/sha256/sha512/md5/sha3 of the key. A minted key's `keys-<project>-<label>` name, or a name equal to the project | **live**: 200, per-key rows incl. a key named "temp" ($65 in 7d) and no-key web usage. `/v1/usage/character-stats` `breakdown_type=api_keys` was empty, hence the newer endpoint |
| Anthropic | per key, $ **allocated** | `GET /v1/organizations/usage_report/messages?group_by[]=api_key_id&group_by[]=model` (tokens) + `GET /v1/organizations/cost_report?group_by[]=description` (cents, can't group by key). Each (day, model, token type) cost is split by token share; non-token costs stay on the account line | `partial_key_hint` | needs an Admin key — "needs admin key" until Sal runs `keys admin set anthropic --clipboard` |
| OpenRouter | per key, $ (windows) | `GET /api/v1/key` with each key itself: `usage_daily`, `usage_weekly` (UTC week to date) — no day series, so no sparkline and the window column is week-to-date | by value (we called with it) | **live**: 200 for the one OpenRouter value (CADAM + monte) |
| fal | per key, $ | `GET api.fal.ai/v1/models/usage?timeframe=day&expand=time_series&expand=auth_method_structured` | key id = the part of the value before `:` | needs an ADMIN-scope key; unexercised |
| xAI | account, $ | `POST management-api.x.ai/v1/billing/teams/{team}/usage` (usd sum per day); no documented per-key group | — | needs a management key; unexercised |
| Gemini, Groq, Replicate, custom | none | no usage API | — | shows "no usage API" + console URL |

Adding a provider: one file in `src/lib/keys/usage/` exporting a `UsageFetcher` + a line
in `usage/index.ts`.

## Drydock (2026-10-04)

keys is a client of the Drydock portal's plain tRPC (`DRYDOCK_URL`, default
`http://localhost:4400/trpc`, `src/lib/keys/drydock.ts`): `projects.list`, `projects.env.list`
/ `env.set` / `env.applyChanges`, `projects.state`. It never touches the Drydock repo. None of
those calls run anything on the box (ECS describe + SSM *Parameter Store* reads/writes, no
Run Command).

**App → folder** (`src/lib/keys/deployed.ts`). A manual override wins
(`keys drydock map <app> <folder|->`, stored in the vault as `drydock.overrides`); else the
folder whose `.git/config` origin is the app's GitHub repo (several clones → the one named
like the app/repo); else a folder whose squashed name equals the app or repo name. Mapped
folders get `[dd]` in `keys list`, `keys reuse`, `keys usage`, the Keys screen group headers
and the Usage view.

**Env.** `projects.env.list` returns decrypted values. They're fingerprinted inside
`drydock.ts` and dropped; callers and the cache (`~/.destedtui/keys/drydock.json`, 15-min
freshness) only ever see `var → fingerprint`. A var the portal names without a value is
recorded as `null` ("present, value unknown"); an app whose env can't be read at all counts as
*might use any key*. Both block a revoke until overridden.

**`keys push <project> [--app a] [--provider x] [--no-redeploy] [--dry-run]`**
(`src/lib/keys/push.ts`). For every Drydock app mapped to the folder: each active key goes into
every var the app already has under one of the provider's names (or the provider's server
name — a `VITE_` name is build-time and useless in a container). Unchanged fingerprints are
skipped. Then `env.applyChanges` (re-registers the task def, so a NEW var reaches the
container) and `waitForDeploy` polls `projects.state` until the new PRIMARY deployment is
`COMPLETED` with its tasks running (ok) or `FAILED` / no deployment within a minute / 10 min
timeout (fail, exit 2). Refuses to push on a stale cache when the portal is down.

## Rotate (2026-10-04)

`↻ rotate` on the Keys screen, or `keys rotate` in a terminal (`src/screens/KeysRotate.tsx`,
logic in `src/lib/keys/rotate.ts`). Replaces one shared key with one key per project, then
revokes the shared one.

**List** — every shared key (and any key a walk is still on): fingerprint, provider, N
projects (`· M [dd]`), 7-day $ (from the usage cache; `—` = no provider-side key matched to
this value), state. A click (or enter) opens one; `☠ dead keys` is the dead-key batch. Every screen here
has an action bar whose buttons send the keyboard handler the key they stand for, so a button
and its key share one code path, two-press arming included (the armed button reads
`⚠ confirm: …` and back becomes `✕ cancel`). A click on an overview row flips new key / cut off.

**Overview** — one row per project holding the value, plus folders whose deployed app holds it
even though their `.env` doesn't. Columns: last activity (newest of the last prompt in
`~/.claude/history.jsonl` — the source sal-agent's projectIndex uses — and the last commit in
the reflog), Drydock apps (`●` holds this key, `?` var present with value unknown, `○` deployed
on a different key), plan, step marks. Default plan: **new key** if active (< 30 days) or
deployed, else **cut off**; `space` toggles (`*` marks a changed default). Deployed apps that
hold the value but map to no member folder are listed as strays and block the revoke.

**The walk** — `enter` (twice) starts it: a `rotations[]` record in the vault holds each
project's plan and progress, so quitting (`esc`) and running `keys rotate` again resumes at
the same step. One project at a time, `enter` before each step that changes anything:

1. **new key** — mint where the adapter + admin credential exist; else open the console and
   read the clipboard on the second `enter` (cleared after; `addKey`'s safeguards apply, and the
   old shared value is refused). A project that already has its own non-shared key for the
   provider keeps it. The project's old record is retired *locally only*
   (`replaceLocalOnly`) — the remote revoke waits for the finish.
2. **.env** — `writeEnv` (same file/var the old key lived in).
3. **drydock** (deployed projects only) — `pushProject` for this provider, Apply + redeploy,
   wait for the deploy result.
4. **verify** — one cheap authenticated read with the new key (`src/lib/keys/verify.ts`:
   OpenAI/Groq `GET /models`, Anthropic `GET /v1/models`, ElevenLabs `GET /v1/models`, Gemini
   `GET /v1beta/models`, xAI `GET /v1/api-key`, OpenRouter `GET /api/v1/key`, Replicate
   `GET /v1/account`, TypeSafe `GET api.typesafe.ai/v1/models`). Status code only; a 401 is retried twice (fresh keys propagate). fal and
   custom providers have no cheap check: marked "unverified", not failed.

A failed step records the error on that project and stays the next step. Progress reads
`3/8 done` on the walk and the overview.

**Finish** — only when every "new key" project has all steps done and verify OK. `enter`
re-reads Drydock (no stale cache), refuses while any app still holds the old fingerprint or
an unmapped app does, and wants `override on` for apps whose value is unknown. Then `enter`
twice: revoke at the provider through the adapter (remote id, or `locate` by value); without
one, the console opens and the status line names the key (minted ones by their
`keys-<project>` name, others by their last 4 characters), and the next `enter` confirms it's
gone. Every remaining record of the value is marked revoked and its line removed from the
`.env` files of the cut-off projects (only where the line still holds that value).

**Dead keys** (`d`, or `keys rotate --dead`) — shared keys with no project active in 30
days and no Drydock app holding the value. A row click picks, `✓ pick all clear` picks every clear one,
`✕ revoke picked` twice revokes them one after another with the same adapter / console fallback. A key that a
deployed app *might* hold (value unknown) is shown `[⛔]` and can't be picked until its row's `⛔ override`
lifts it. A deployed project whose app demonstrably runs a different value doesn't keep a
key alive.

**Dry runs.** Every step function takes `dryRun`. `keys rotate --fingerprint <fp> [--new
a,b] [--cut c] --dry-run` prints the overview, every step for every project and the finish;
`keys rotate --dead --dry-run` prints the batch; `keys rotate --simulate` opens the screen with
every step simulated and progress held in memory only. `keys rotate` with no TTY prints the
list.

## Not built (next)

- OpenAI has no `locate`, so imported (not minted) OpenAI keys are revoked in the console. The
  admin API lists project api_keys with a `redacted_value` (the usage code already matches on
  it) and can delete them — a `locate` + api-key revoke would make those one keypress.
- The walk runs in the screen only; there is no non-interactive `keys rotate --yes`.
- ElevenLabs keys whose name isn't the project (e.g. "temp") can't be matched — rename them
  in the ElevenLabs console to the project name, or mint replacements with `keys new`.
- Imported keys that live in two files of one project (`web/.env` + `.env.local`) are
  managed in the first file only; the second copy is reported as "already known".
