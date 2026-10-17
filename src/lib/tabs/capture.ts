import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { processTable, type ProcInfo } from "../ports.ts";
import type { SavedTab, Snapshot, TabDetail } from "./store.ts";
import { lastPrompt, transcriptPath } from "./transcript.ts";
import { probeAndMarkWsl, SELF_TTY_ENV, setWslTitles, shellJoin, type ClaudeSession, type WslPane } from "./wsl.ts";

// `tabs save`: which Claude session / shell / app is in each tab of one
// Windows Terminal window (features/tabs.md § Capture).
//
// Windows Terminal doesn't say which process belongs to which tab, so we ask
// the tabs themselves: give every pane a unique title, read the window's tab
// titles back through UI Automation, and put every title back. Windows panes
// are retitled through their console (scripts/tabs-console.ps1); WSL panes by
// writing OSC 0 to their pts (lib/tabs/wsl.ts), since the pts is what tells us
// which Linux session it is. Every pane root's console title is read first and
// set back last, so even an inactive split gets its exact title back.

const SCRIPTS = join(import.meta.dir, "..", "..", "..", "scripts");
const WT_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS";
const MARK_WAIT_MS = 300;
const RETRY_WAIT_MS = 600;
const RELAY_WAIT_MS = 200;
/** Children of a pwsh pane that are never "the app in this tab". */
const NOT_APPS = new Set(["conhost.exe", "openconsole.exe", "oh-my-posh.exe"]);

// ─── Win32 ────────────────────────────────────────────────────────────────────

function user32() {
  return dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: FFIType.u64 },
    GetClassNameW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  }).symbols;
}

function classOf(u: ReturnType<typeof user32>, hwnd: bigint): string {
  const buf = new Uint16Array(256);
  const n = u.GetClassNameW(hwnd, ptr(buf), buf.length);
  return n > 0 ? Buffer.from(buf.buffer, 0, n * 2).toString("utf16le") : "";
}

function ownerPid(u: ReturnType<typeof user32>, hwnd: bigint): number {
  const out = new Uint32Array(1);
  u.GetWindowThreadProcessId(hwnd, ptr(out));
  return out[0] ?? 0;
}

// ─── helpers (pwsh) ───────────────────────────────────────────────────────────

async function pwsh(script: string, args: string[], input?: string): Promise<string> {
  const p = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-File", join(SCRIPTS, script), ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    // No console window of its own: tabs-console.ps1 FreeConsole/AttachConsoles,
    // and it must never be attached to (or show/hide) the terminal we run in.
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${script} exited ${code}: ${err.trim().slice(0, 300)}`);
  return out;
}

const WindowTabs = z.object({ hwnd: z.number(), tabs: z.preprocess((v) => v ?? [], z.array(z.string())) });
type WindowTabs = z.infer<typeof WindowTabs>;

/** Every Windows Terminal window and its tab titles in visual order. */
export async function readWindows(): Promise<WindowTabs[]> {
  return z.array(WindowTabs).parse(JSON.parse(await pwsh("tabs-uia.ps1", [])));
}

const TitleResult = z.object({ pid: z.number(), ok: z.boolean(), prior: z.string() });

/** Set (or, with title null, just read) each pid's console title; returns what each was before. */
async function setConsoleTitles(req: { pid: number; title: string | null }[]): Promise<z.infer<typeof TitleResult>[]> {
  if (req.length === 0) return [];
  return z.array(TitleResult).parse(JSON.parse(await pwsh("tabs-console.ps1", [], JSON.stringify(req))));
}

// ─── the capture ──────────────────────────────────────────────────────────────

export interface CaptureOptions {
  /** test override: capture this window instead of the foreground one */
  hwnd?: number;
}

export interface Skipped {
  /** panes whose marker showed up in another Windows Terminal window */
  otherWindow: number;
  /** panes whose marker showed up nowhere: inactive split panes, renamed tabs, non-Terminal ttys */
  hidden: number;
}

export interface Capture {
  window: Snapshot["window"];
  tabs: SavedTab[];
  skipped: Skipped;
  /** tabs in the window no pane could be matched to (this one, renamed tabs), with their titles */
  unmapped: { index: number; title: string; self: boolean }[];
  /** titles that didn't go back cleanly */
  warnings: string[];
}

/** "🔔 factorio-stuff" → "factorio-stuff". */
export function cleanTitle(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").trim() || raw.trim();
}

const MARK_RE = (token: string) => new RegExp(`§tabs-${token}-(pts)?(\\d+)`);

type PaneKey = string; // "w:<pid>" | "l:<pts>"

/** Where each marker showed up: key → { hwnd, index }. */
function locate(windows: WindowTabs[], token: string): Map<PaneKey, { hwnd: number; index: number }> {
  const re = MARK_RE(token);
  const out = new Map<PaneKey, { hwnd: number; index: number }>();
  for (const w of windows)
    w.tabs.forEach((t, index) => {
      const m = re.exec(t);
      if (m) out.set(`${m[1] ? "l" : "w"}:${m[2]}`, { hwnd: w.hwnd, index });
    });
  return out;
}

const SessionFile = z.object({ sessionId: z.string(), cwd: z.string(), name: z.string().optional(), kind: z.string().optional() });

function windowsSession(pid: number): ClaudeSession | null {
  const file = join(homedir(), ".claude", "sessions", `${pid}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = SessionFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success && (parsed.data.kind ?? "interactive") === "interactive" ? parsed.data : null;
  } catch {
    return null;
  }
}

function childrenOf(procs: Map<number, ProcInfo>): Map<number, ProcInfo[]> {
  const kids = new Map<number, ProcInfo[]>();
  for (const p of procs.values()) {
    if (p.ppid === p.pid) continue;
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  return kids;
}

function describeWindowsPane(root: ProcInfo, kids: Map<number, ProcInfo[]>): TabDetail {
  // The shallowest claude.exe under the pane with an interactive session file.
  const queue: ProcInfo[] = [...(kids.get(root.pid) ?? [])];
  while (queue.length > 0) {
    const p = queue.shift();
    if (!p) break;
    if (p.exe.toLowerCase() === "claude.exe") {
      const s = windowsSession(p.pid);
      if (s) {
        const t = transcriptPath("windows", s.cwd, s.sessionId);
        return { platform: "windows", kind: "claude", cwd: s.cwd, sessionId: s.sessionId, sessionName: s.name ?? "", lastPrompt: t ? lastPrompt(t) : "" };
      }
    }
    queue.push(...(kids.get(p.pid) ?? []));
  }
  const apps = (kids.get(root.pid) ?? []).filter((p) => !NOT_APPS.has(p.exe.toLowerCase())).sort((a, b) => b.startedAt - a.startedAt);
  const app = apps[0];
  if (app) return { platform: "windows", kind: "app", cwd: app.cwd || root.cwd, command: app.cmdline.trim() || app.exe };
  return { platform: "windows", kind: "shell", cwd: root.cwd };
}

function describeWslPane(p: WslPane): TabDetail {
  if (p.fgPid === p.shellPid) return { platform: "wsl", kind: "shell", cwd: p.shellCwd };
  const s = p.session;
  if (s && (s.kind ?? "interactive") === "interactive") {
    const t = transcriptPath("wsl", s.cwd, s.sessionId);
    return { platform: "wsl", kind: "claude", cwd: s.cwd, sessionId: s.sessionId, sessionName: s.name ?? "", lastPrompt: t ? lastPrompt(t) : "" };
  }
  const command = p.fgArgv.length > 0 ? shellJoin(p.fgArgv) : p.fgComm;
  return { platform: "wsl", kind: "app", cwd: p.fgCwd || p.shellCwd, command };
}

export class CaptureError extends Error {}

export async function capture(opts: CaptureOptions = {}): Promise<Capture> {
  if (process.platform !== "win32") throw new CaptureError("tabs save runs on Windows (the Linux bin forwards to tabs.exe)");
  const u = user32();
  const hwnd = opts.hwnd !== undefined ? BigInt(opts.hwnd) : u.GetForegroundWindow();
  if (hwnd === 0n || classOf(u, hwnd) !== WT_CLASS) throw new CaptureError("run this from a Windows Terminal tab");
  const target = Number(hwnd);
  const wtPid = ownerPid(u, hwnd);

  const before = await readWindows();
  const targetBefore = before.find((w) => w.hwnd === target);
  if (!targetBefore) throw new CaptureError(`window ${target} isn't a Windows Terminal window UI Automation can see`);

  const table = processTable();
  if (table.error) throw new CaptureError(table.error);
  const procs = table.procs;
  const kids = childrenOf(procs);

  // Our own pane gets stamped like the rest, so its tab is known rather than guessed,
  // then set aside: the Windows pane we descend from, or (forwarded from WSL) our pts.
  const ancestors = new Set<number>();
  for (let p = procs.get(process.pid); p && !ancestors.has(p.pid); p = procs.get(p.ppid)) ancestors.add(p.pid);
  const roots = (kids.get(wtPid) ?? []).filter((p) => p.exe.toLowerCase() !== "openconsole.exe");
  const winRoots = roots.filter((p) => p.exe.toLowerCase() !== "wsl.exe");
  const wslRoots = roots.filter((p) => p.exe.toLowerCase() === "wsl.exe");
  const selfKeys = new Set<PaneKey>();
  for (const p of winRoots) if (ancestors.has(p.pid)) selfKeys.add(`w:${p.pid}`);
  const selfPts = /^\/dev\/pts\/(\d+)$/.exec(process.env[SELF_TTY_ENV] ?? "");
  if (selfPts) selfKeys.add(`l:${selfPts[1]}`);

  const token = randomBytes(4).toString("hex");
  const warnings: string[] = [];
  let marked: { pid: number; ok: boolean; prior: string }[] = [];
  let wslPanes: WslPane[] = [];
  const found = new Map<PaneKey, { hwnd: number; index: number }>();

  try {
    // Windows panes get their marker; WSL panes' consoles are only read, before the pts writes land.
    marked = await setConsoleTitles([
      ...winRoots.map((p) => ({ pid: p.pid, title: `§tabs-${token}-${p.pid}` })),
      ...wslRoots.map((p) => ({ pid: p.pid, title: null })),
    ]).catch((err: unknown) => {
      warnings.push(`pane consoles: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    const wslMark = await probeAndMarkWsl(token);
    wslPanes = wslMark.panes;
    if (wslMark.error) warnings.push(`wsl panes: ${wslMark.error}`);
    const winPids = new Set(winRoots.map((p) => p.pid));
    const expected = marked.filter((m) => m.ok && winPids.has(m.pid)).length + wslPanes.length;

    await Bun.sleep(MARK_WAIT_MS);
    for (const [k, v] of locate(await readWindows(), token)) found.set(k, v);
    if (found.size < expected) {
      // A busy claude retitles its tab constantly; give the stragglers one more look.
      await Bun.sleep(RETRY_WAIT_MS);
      for (const [k, v] of locate(await readWindows(), token)) if (!found.has(k)) found.set(k, v);
    }
  } finally {
    // Never leave a marker behind, whatever happened above. A pts we never saw
    // on a tab may not be a Terminal pane at all (an editor's terminal): its
    // title goes to "" (the profile's). Then every pane root's console gets the
    // exact title it had, which also covers the pts inside Windows Terminal.
    const wslBack = new Map<number, string>();
    for (const p of wslPanes) {
      const at = found.get(`l:${p.pts}`);
      const win = at ? before.find((w) => w.hwnd === at.hwnd) : undefined;
      wslBack.set(p.pts, at && win ? (win.tabs[at.index] ?? "") : "");
    }
    const wslErr = await setWslTitles(wslBack);
    if (wslErr) warnings.push(`wsl pane titles: ${wslErr}`);
    // The pts writes reach the console through wsl.exe's relay; let them land first.
    await Bun.sleep(RELAY_WAIT_MS);
    const back = marked.filter((m) => m.ok).map((m) => ({ pid: m.pid, title: m.prior }));
    const winErr = await setConsoleTitles(back).then(
      (r) => (r.some((x) => !x.ok) ? `${r.filter((x) => !x.ok).length} pane titles didn't go back` : null),
      (err: unknown) => `pane titles: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (winErr) warnings.push(winErr);
  }

  // ─── map tabs ──────────────────────────────────────────────────────────────
  const byPid = new Map(winRoots.map((p) => [p.pid, p]));
  const byPts = new Map(wslPanes.map((p) => [p.pts, p]));
  const atIndex = new Map<number, PaneKey>();
  for (const [k, v] of found) if (v.hwnd === target) atIndex.set(v.index, k);

  const tabs: SavedTab[] = [];
  const unmapped: Capture["unmapped"] = [];
  // Titles from the before-read: tabs don't move in a second, and those are the real ones.
  targetBefore.tabs.forEach((rawTitle, index) => {
    const key = atIndex.get(index);
    if (key && selfKeys.has(key)) return unmapped.push({ index, title: rawTitle, self: true });
    const wslPane = key?.startsWith("l:") ? byPts.get(Number(key.slice(2))) : undefined;
    const winPane = key?.startsWith("w:") ? byPid.get(Number(key.slice(2))) : undefined;
    const detail: TabDetail | null = wslPane ? describeWslPane(wslPane) : winPane ? describeWindowsPane(winPane, kids) : null;
    if (!detail) return unmapped.push({ index, title: rawTitle, self: false });
    tabs.push({ ...detail, index, title: cleanTitle(rawTitle), rawTitle });
  });

  let otherWindow = 0;
  let hidden = 0;
  const all: PaneKey[] = [...winRoots.filter((p) => marked.some((m) => m.ok && m.pid === p.pid)).map((p): PaneKey => `w:${p.pid}`), ...wslPanes.map((p): PaneKey => `l:${p.pts}`)];
  for (const k of all) {
    if (selfKeys.has(k)) continue;
    const at = found.get(k);
    if (!at) hidden++;
    else if (at.hwnd !== target) otherWindow++;
  }
  return { window: { hwnd: target, tabCount: targetBefore.tabs.length }, tabs, skipped: { otherWindow, hidden }, unmapped, warnings };
}
