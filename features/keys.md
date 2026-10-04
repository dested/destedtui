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
pattern), choice fields cycle with ←/→.

## Not built (next)

- `keys push <project>` → Drydock env (SSM). Not tonight.
- Usage / spend per key.
- Imported keys that live in two files of one project (`web/.env` + `.env.local`) are
  managed in the first file only; the second copy is reported as "already known".
