import { WSL_DISTRO } from "../platform.ts";
import type { SavedTab } from "./store.ts";
import { transcriptPath } from "./transcript.ts";

// `tabs restore`: one `wt -w 0 …` call that opens every chosen tab in the
// current Windows Terminal window, in saved order (features/tabs.md § Restore).
// WSL tabs use the form claude-sessions.ps1 has in production: zsh runs
// SAL_RUN once at startup, then stays interactive.

/** The `sal` Windows Terminal profile WSL tabs open with. */
const WSL_PROFILE = process.env.TABS_WSL_PROFILE || "sal";

export interface Choice {
  tab: SavedTab;
  /** claude/shell: open the tab. app: relaunch the app (unchecked = a plain shell in its cwd). */
  on: boolean;
}

/** A row's state as the restore screen shows it. */
export interface RestoreRow {
  tab: SavedTab;
  /** claude only: the session's .jsonl is gone, so --resume would fail */
  transcriptMissing: boolean;
  /** the default checkbox: claude/shell on, apps off, missing transcripts off */
  defaultOn: boolean;
}

export function restoreRows(tabs: SavedTab[]): RestoreRow[] {
  return tabs.map((tab) => {
    const transcriptMissing = tab.kind === "claude" && transcriptPath(tab.platform, tab.cwd, tab.sessionId) === null;
    return { tab, transcriptMissing, defaultOn: tab.kind !== "app" && !transcriptMissing };
  });
}

/** pwsh -Command text without a `"` or `;` travels as is; anything else goes base64 (-EncodedCommand). */
function pwshCommand(command: string): string[] {
  if (!/["`;]/.test(command)) return ["-Command", command];
  return ["-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

/** A Windows command line (`"C:\x\a.exe" --flag`) as something pwsh runs. */
function pwshInvoke(cmdline: string): string {
  return /^\s*["']/.test(cmdline) ? `& ${cmdline.trim()}` : cmdline.trim();
}

/** The new-tab args for one tab, or null when it isn't opened at all. */
export function tabArgs(c: Choice): string[] | null {
  const { tab, on } = c;
  if (!on && tab.kind !== "app") return null;
  const head = ["new-tab", "--title", tab.title];
  if (tab.platform === "windows") {
    const shell = ["pwsh", "-NoExit"];
    if (tab.kind === "claude") return [...head, "-d", tab.cwd, ...shell, ...pwshCommand(`claude --resume ${tab.sessionId}`)];
    if (tab.kind === "app" && on) return [...head, "-d", tab.cwd, ...shell, ...pwshCommand(pwshInvoke(tab.command))];
    return [...head, "-d", tab.cwd, ...shell];
  }
  const wsl = [...head, "-p", WSL_PROFILE, "wsl.exe", "-d", WSL_DISTRO, "--cd", tab.cwd, "--exec", "env"];
  if (tab.kind === "claude") return [...wsl, `SAL_RUN=claude --resume ${tab.sessionId}`, "zsh", "-l"];
  if (tab.kind === "app" && on) return [...wsl, `SAL_RUN=${tab.command}`, "zsh", "-l"];
  return [...wsl, "zsh", "-l"];
}

/**
 * The whole `wt` argv (without the `wt` itself). Windows Terminal splits its
 * command line on `;`, so a literal one inside an argument is `\;`.
 */
export function wtArgs(choices: Choice[]): string[] {
  const out = ["-w", "0"];
  let first = true;
  for (const c of choices) {
    const args = tabArgs(c);
    if (!args) continue;
    if (!first) out.push(";");
    first = false;
    out.push(...args.map((a) => a.replace(/;/g, "\\;")));
  }
  return out;
}

/** How many tabs a set of choices opens. */
export function openCount(choices: Choice[]): number {
  return choices.filter((c) => tabArgs(c) !== null).length;
}

/** Show an argv the way Windows will parse it back (quotes only where needed). */
export function quoteArg(a: string): string {
  return a === "" || /[\s"]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"` : a;
}

/** The packaged wt.exe. Bun.spawn can't launch the WindowsApps app-execution alias
 * (it reports "Executable not found" even by full path), so ask Appx where Terminal lives. */
async function wtExe(): Promise<string> {
  const p = Bun.spawn(["pwsh", "-NoProfile", "-Command", "(Get-AppxPackage Microsoft.WindowsTerminal).InstallLocation"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true,
  });
  const dir = (await new Response(p.stdout).text()).trim().split(/\r?\n/)[0] ?? "";
  if (dir) {
    const exe = `${dir}\\wt.exe`;
    if (await Bun.file(exe).exists()) return exe;
  }
  return "wt.exe";
}

/** Open the tabs. Resolves once wt.exe has taken the request (it exits right away). */
export async function runWt(args: string[]): Promise<{ ok: boolean; error: string | null }> {
  if (process.platform !== "win32") return { ok: false, error: "restore runs on Windows (the Linux bin forwards to tabs.exe)" };
  try {
    const p = Bun.spawn([await wtExe(), ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return code === 0 ? { ok: true, error: null } : { ok: false, error: `wt.exe exited ${code}${err.trim() ? `: ${err.trim()}` : ""}` };
  } catch (err) {
    return { ok: false, error: `wt.exe: ${err instanceof Error ? err.message : String(err)}` };
  }
}
