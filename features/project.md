# Project panel

> Status: **done** · Last updated: 2026-10-28

## What / Why

One screen per project with everything you can do there, modelled on the old Deck app's Stack/System/Preview tabs. It shows what's running and who started it, every database the project can reach (local, `.env` remotes, Drydock prod), whether prisma migrations are applied, and buttons for Studio, prisma, the dev server, tunnel, backup and pull. Beside it: git, Claude sessions and spend, Drydock, env names. It's the front page whenever `destedtui` starts inside a project.

## Behavior spec

- **Which project:** `projectAt(cwd, roots)` returns the first folder under a projects root (`W:\code`, `G:\code`, `/w/code`), else the git toplevel, else the cwd. It returns null at a root itself, and then the panel shows "not a project". `--project <name|path>` opens one directly. When the start route is the menu and the cwd is in a project, the stack is `[menu, project]`, so esc lands on utilities. The menu's first tile is `⌂ <project>` whenever there is one.
- **Servers:** every listening unit whose process tree works inside the project, or whose cmdline names its folder. Owners:
  - Claude session (its label);
  - `this panel`;
  - `orphan`;
  - `your shell`;
  - `wsl`.

  Rows show port, page title, command, owner, uptime and memory, with ↗ open and a two-press ✕ kill (tree kill on Windows; `pkill -P` + `kill` TERM inside WSL). The scan runs every 2 s. `▶ <dev command>` buttons start the project's dev scripts as panel jobs, and pressing one again stops it.
- **WSL servers:** the Windows build can't see WSL listeners, and a W:\ project's servers almost always run there. For a W:\ project the panel reads `~/.bun/bin/destedtui --ports --json` inside the distro every 6 s (about 1.4 s a call, off the render path).
- **Databases:** one row per distinct target, deduped by host/db:
  - `.env*` URLs (local or remote);
  - `prod · <app>` for each Drydock app with a database (URL from the portal's `projects.localDbUrl`, held in memory only).

  Each row is probed once (one pg connection, ssl tried both ways): version, size, table count, and `_prisma_migrations` diffed against the repo's migrations folder (`migrations ✓ n/n`, `n pending`, `n unknown`, `n failed`, or `db push` when the table is absent).
- **Reaching prod:** direct to the box's EIP when port 5432 answers (the box opens it to this machine's IP); otherwise `⇄ tunnel` runs `aws ssm start-session` with `AWS-StartPortForwardingSessionToRemoteHost` to `172.17.0.1:5432` under the `dested` profile (`DRYDOCK_AWS_PROFILE` overrides). Tunnel only, never a shell: Sal's standing OK (2026-10-28). It needs the AWS CLI plus session-manager-plugin, and the panel says which one is missing.
- **Studio:** `◧ studio` runs `prisma studio --port <free> --browser none` with the target's URL in the schema's url env, then opens Chrome when the port answers. A non-local target arms first (two presses).
- **Prisma bar:** `on <target>` picks the database, then:
  - `generate`;
  - `status` / `deploy` (when the repo has migrations);
  - `migrate dev`, in a term pane, since it needs a TTY; never against a remote;
  - `db push`.

  `push` and `deploy` on a remote arm first. After a job, the target is re-probed.
- **Jobs:** dev, prisma, studio and tunnel are module-level jobs (`lib/project/jobs.ts`). They outlive leaving the screen, die on quit (tree kill), and hold off the idle pause. The console bar picks a job's output: ↗ open, ■ stop, ✕ clear. Postgres passwords are scrubbed from every kept line.
- **W:\ projects run in WSL:** from the Windows build, every job and the `migrate dev` pane run through `inDistro` (`wsl.exe -d sal --cd /w/… --exec zsh -lc`) because their `node_modules` are Linux builds. Env crosses through `WSLENV`. Killing `wsl.exe` takes the Linux side with it.
- **Activity column:**
  - git: branch, upstream, dirty, last 5 commits, through Linux git for W:\;
  - claude: `✦ claude here`, `▓ shell`, live sessions, 7d/30d spend with a daily sparkline;
  - drydock: app, running, `↗ domain`, `↗ portal`, last deploy and predeploy, SSM var names against local `.env` names;
  - env files: var names only.

  Under 150 columns the two columns become tabs.
- **`--project [name|path] --json`:** the same picture as versioned JSON (`v: 1`; add fields, never rename) for other tools. `--no-db` skips the probes. It never opens a tunnel, never includes a URL or secret (only `where`), and exits 1 when there's no project.

## Touchpoints

| Part | File |
| --- | --- |
| Which project a cwd is | `src/lib/project/context.ts` |
| Schemas, prisma CLI, actions | `src/lib/project/prisma.ts` |
| Targets, probes, migration diff | `src/lib/project/db.ts` |
| Drydock apps, prod reach | `src/lib/project/drydock.ts` |
| Tunnel, url resolution, Studio | `src/lib/project/reach.ts` |
| Jobs | `src/lib/project/jobs.ts` |
| Servers (Windows + WSL), kill | `src/lib/project/servers.ts` |
| Static picture, env names, commits | `src/lib/project/inspect.ts` |
| Whole picture + JSON | `src/lib/project/picture.ts`, `src/lib/project/cli.ts` |
| Claude spend | `src/lib/project/usage.ts`, `usageWorker.ts` |
| Run in the distro | `inDistro` in `src/lib/platform.ts` |
| UI | `src/screens/Project.tsx` |

## Open

- The tunnel is untested: session-manager-plugin isn't installed on this machine (`winget install Amazon.SessionManagerPlugin`).
- WSL servers show the owner `wsl`; the Windows build can't tell which Claude session in the distro started one, and Claude sessions working in WSL don't list under "claude" (spend does).
