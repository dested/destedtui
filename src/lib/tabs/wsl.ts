import { z } from "zod";
import { WSL_DISTRO } from "../platform.ts";

// The WSL half of `tabs save`, run from the Windows build through wsl.exe.
// A WSL tab's shell is a session leader on /dev/pts/N; writing an OSC 0 title
// to that tty retitles its Windows Terminal tab, which is how we learn which
// tab each pts is. One wsl.exe call lists and stamps every pts at once,
// another puts the titles back.

/** The pts the `tabs` call itself came from (the Linux bin sets it before forwarding). */
export const SELF_TTY_ENV = "TABS_SELF_TTY";

const SHELLS = "zsh|bash|sh|fish|dash";

// $1 token. One line per pane (our own included: capture.ts sets it aside):
// T|n|shellPid|fgPid|fgComm|b64 shellCwd|b64 fgArgv (NUL-separated)|b64 fgCwd|b64 session json
const PROBE = `
set -u
tok=$1
mysid=$(ps -o sid= -p $$ | tr -d ' ')
ps -eo pid=,tty=,tpgid=,sid=,comm= | while read -r pid tty tpgid sid comm; do
  [ "$pid" = "$sid" ] || continue
  case "$tty" in pts/*) ;; *) continue ;; esac
  case "$comm" in ${SHELLS}) ;; *) continue ;; esac
  [ "$sid" = "$mysid" ] && continue
  n=\${tty#pts/}
  fg=$tpgid
  [ -d "/proc/$fg" ] || fg=$pid
  fgcomm=$(cat /proc/$fg/comm 2>/dev/null)
  shcwd=$(readlink /proc/$pid/cwd 2>/dev/null | base64 -w0)
  argv=$(base64 -w0 < /proc/$fg/cmdline 2>/dev/null)
  fgcwd=$(readlink /proc/$fg/cwd 2>/dev/null | base64 -w0)
  sess=""
  [ -f "$HOME/.claude/sessions/$fg.json" ] && sess=$(base64 -w0 < "$HOME/.claude/sessions/$fg.json")
  timeout 2 bash -c 'printf "\\033]0;\\302\\247tabs-%s-pts%s\\007" "$1" "$2" > "/dev/$3"' _ "$tok" "$n" "$tty" 2>/dev/null
  echo "T|$n|$pid|$fg|$fgcomm|$shcwd|$argv|$fgcwd|$sess"
done
`;

const ClaudeSession = z.object({
  pid: z.number().optional(),
  sessionId: z.string(),
  cwd: z.string(),
  name: z.string().optional(),
  kind: z.string().optional(),
});
export type ClaudeSession = z.infer<typeof ClaudeSession>;

export interface WslPane {
  pts: number;
  shellPid: number;
  fgPid: number;
  fgComm: string;
  shellCwd: string;
  /** the foreground process's argv; the shell's own when nothing else is in front */
  fgArgv: string[];
  fgCwd: string;
  /** the Claude Code session file when the foreground process is an interactive claude */
  session: ClaudeSession | null;
}

/** base64 → text, without the newline readlink ends its output with. */
const b64 = (s: string): string => Buffer.from(s, "base64").toString("utf8").replace(/\n$/, "");

function parseSession(s: string): ClaudeSession | null {
  if (!s) return null;
  try {
    const parsed = ClaudeSession.safeParse(JSON.parse(b64(s)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function wsl(script: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(["wsl.exe", "-d", WSL_DISTRO, "--exec", "bash", "-s", "--", ...args], {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, code: await p.exited };
}

/** List every pts shell in the distro and stamp each tab with `§tabs-<token>-pts<n>`. */
export async function probeAndMarkWsl(token: string): Promise<{ panes: WslPane[]; error: string | null }> {
  let r: { out: string; err: string; code: number };
  try {
    r = await wsl(PROBE, [token]);
  } catch (err) {
    return { panes: [], error: `wsl.exe: ${err instanceof Error ? err.message : String(err)}` };
  }
  const panes: WslPane[] = [];
  for (const line of r.out.split("\n")) {
    const f = line.trim().split("|");
    if (f[0] !== "T" || f.length < 9) continue;
    const pts = Number(f[1]);
    if (!Number.isInteger(pts)) continue;
    const argv = Buffer.from(f[6] ?? "", "base64").toString("utf8").split("\0").filter((a) => a.length > 0);
    panes.push({
      pts,
      shellPid: Number(f[2]),
      fgPid: Number(f[3]),
      fgComm: f[4] ?? "",
      shellCwd: b64(f[5] ?? ""),
      fgArgv: argv,
      fgCwd: b64(f[7] ?? ""),
      session: parseSession(f[8] ?? ""),
    });
  }
  const error = r.code !== 0 && panes.length === 0 ? `wsl.exe exited ${r.code}: ${r.err.trim().slice(0, 200)}` : null;
  return { panes, error };
}

/** Put titles back: pts → title ("" lets Windows Terminal fall back to the profile's). */
export async function setWslTitles(titles: Map<number, string>): Promise<string | null> {
  if (titles.size === 0) return null;
  const lines = ["set -u"];
  for (const [pts, title] of titles) {
    const enc = Buffer.from(title, "utf8").toString("base64");
    lines.push(
      `timeout 2 bash -c 'printf "\\033]0;%s\\007" "$(printf %s "$1" | base64 -d)" > "/dev/pts/$2"' _ '${enc}' ${pts} 2>/dev/null`,
    );
  }
  try {
    const r = await wsl(`${lines.join("\n")}\n`, []);
    return r.code === 0 ? null : `wsl.exe exited ${r.code}`;
  } catch (err) {
    return `wsl.exe: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * argv → one POSIX command line for `SAL_RUN` (zsh evals it). It must survive
 * Windows Terminal and wsl.exe's own command-line parsing on the way, so it
 * never contains a double quote or a `;`: anything awkward goes in $'…' with
 * hex escapes.
 */
export function shellJoin(argv: string[]): string {
  return argv
    .map((a) => {
      if (SAFE.test(a)) return a;
      if (!/['"\\;\x00-\x1f\x7f]/.test(a)) return `'${a}'`;
      let out = "$'";
      for (const ch of a) {
        const c = ch.codePointAt(0) ?? 0;
        if (ch === "'" || ch === '"' || ch === "\\" || ch === ";" || c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
        else out += ch;
      }
      return `${out}'`;
    })
    .join(" ");
}
