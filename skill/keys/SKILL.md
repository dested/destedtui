---
name: keys
description: Sal's API-key vault (`keys` CLI, from destedtui). Use whenever an AI/API key is involved — "new key", "make me a key", "make me a new ElevenLabs key for pickleball", "API key", "rotate the key", "revoke that key", "which key does X use", "is this key reused", a project missing OPENAI_API_KEY/ANTHROPIC_API_KEY/ELEVENLABS_API_KEY/etc. in its .env, or a key pasted into chat. One key per project per provider; the vault writes it into the project's gitignored .env. Never print, echo or paste a key value.
---

# keys — one vault for every AI API key

`keys` is a global bin (destedtui). The vault is DPAPI-encrypted at
`~/.destedtui/keys/vault.bin`. Every key belongs to one project (a folder under
`G:\code`, or `shared`) and one provider. Output shows **fingerprints** (sha256
prefix), never values.

## Hard rules

- **Never print, echo, cat or paste a key value.** Don't read `.env` files into the
  transcript (`grep -l`, or mask values: `sed 's/=.*/=…/'`). Never run `keys reveal`
  or `keys values` (they refuse inside Claude Code anyway).
- **Never ask Sal to paste a key into chat.** Keys arrive through the clipboard
  (`--clipboard`, which clears it afterwards) or `--stdin` from a file — never argv.
- **One key per project per provider.** Don't copy one project's key into another;
  make a new one. `keys reuse` lists the existing offenders.
- If Sal pastes a key into chat anyway: tell him it's now in the transcript, get it
  into the vault without echoing it (he copies it again → `keys add … --clipboard`),
  and recommend revoking/rotating it.

## "Make me a new <provider> key for <project>"

```
keys new <provider> --project <project>
```

- **Minted** (prints `✓ minted … fp …`): done. It's stored and already written into
  `<project>/.env` (gitignore checked). Tell Sal the fingerprint and the env var.
- **Console-only / no admin credential** (prints `opened https://…` and a `next:`
  line): the console page is open in Chrome. Tell Sal: *"Create a key named
  `<project>` there, copy it, and say done."* When he says done:

  ```
  keys add <provider> --project <project> --clipboard
  ```

  That stores it, writes the `.env`, and clears the clipboard.

If the project already has a key for that provider, `new`/`add` refuse; add
`--replace` to rotate (the old one is revoked remotely when the provider allows it and
no other project shares the value).

## Other commands

| Need | Command |
| --- | --- |
| What keys does a project use | `keys list --project <p>` (`--json` for parsing) |
| Everything for one provider | `keys list --provider <id>` |
| Keys shared across projects | `keys reuse` |
| Re-sync a project's `.env` from the vault | `keys env <project>` (`--dry-run` first if unsure) |
| Revoke | `keys revoke <id>` (remote when possible; removes the `.env` line) |
| Providers and which can mint | `keys providers` |
| Admin credentials for minting | `keys admin list`; Sal sets one with `keys admin set <provider> --clipboard` |
| A provider that isn't built in | `keys provider add <id> --name "<Name>" --env-var <VAR> --console-url <url>` |
| Pick up keys sitting in .env files | `keys import` (prints a reuse report) |

`--project` defaults to the project folder the shell is in. Exit codes: 0 ok,
1 user error (read the message — it says what to do), 2 provider API error.

## Which providers mint (2026-10-03)

- **Mint:** OpenAI (project service account; admin from `OPENAI_ADMIN_KEY` or the
  vault), xAI (management key), OpenRouter (management key), fal (admin-scope key),
  ElevenLabs (service accounts — multi-seat plans only; Sal's plan may not allow it).
- **Console only:** Anthropic (Admin API can archive but not create — `revoke`
  archives when an Anthropic admin key is set), Google Gemini, Groq, Replicate, and
  every custom provider.

## Not yet

No Drydock/SSM sync (`keys push` is a next step) and no usage/spend tracking.
