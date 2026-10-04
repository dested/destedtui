# Keys — one vault for every AI API key

> Status: shipped 2026-10-03 (overnight build). Spec: `plans/2026-10-03-keys.md`.

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
- `reveal` / `values` need `--yes-print-secret` and refuse when `CLAUDECODE` is set.
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

Adding an adapter: one file in `src/lib/keys/adapters/` exporting a `MintAdapter`
(`mint`, `revoke`, optional `locate`) + one line in `adapters/index.ts` + `mint: "<id>"` on
the provider.

## Screen

Rows grouped by project (or provider, `g`), each: provider/project, id, fingerprint,
source, file + var, a red `⚠ same key in N projects`, and row buttons `.env` / `↗` / `✕`.
Keys: `n` new/mint, `a` add from clipboard, `w` write .env, `o` console, `x` revoke
(two-press, panel border red, status line says local-only vs remote), `i` import, `p` add
provider, `m` admin credential from clipboard. Forms replace the list (CommandEditor
pattern), choice fields cycle with ←/→. `u` opens the Usage view.

## Usage (2026-10-04)

"Which of my projects are spending right now." `keys usage [--project p] [--provider x]
[--days n] [--refresh] [--json]` and the Usage view on the Keys screen (`u`). Nothing in the
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
(or covering fewer days than asked) refetches; `--refresh` / `r` forces it; the screen also
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

## Not built (next)

- `keys push <project>` → Drydock env (SSM).
- ElevenLabs keys whose name isn't the project (e.g. "temp") can't be matched — rename them
  in the ElevenLabs console to the project name, or mint replacements with `keys new`.
- Imported keys that live in two files of one project (`web/.env` + `.env.local`) are
  managed in the first file only; the second copy is reported as "already known".
