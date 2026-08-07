import { Terminal } from "@xterm/headless";
import { PtyHost } from "./ptyhost.ts";
import { isRecord, patchConfig, readConfig } from "./config.ts";

/**
 * The terminal multiplexer's brain. Owns a fleet of interactive PTY sessions
 * (via the Node sidecar) and one xterm-headless emulator per session that turns
 * raw PTY bytes into a readable cell grid. Module-level singleton so sessions
 * survive navigating away from the workspace and die only on real quit.
 */

export type TermKind = "shell" | "claude";
export type TermStatus = "running" | "exited";
export type Mode = "nav" | "input";

export interface TermSession {
  id: string;
  title: string;
  kind: TermKind;
  cwd: string;
  term: Terminal;
  cols: number;
  rows: number;
  status: TermStatus;
  exitCode: number | null;
  /** When it was spawned — for the card's live age. */
  startedAt: number;
  /** Whether the user has renamed it (so auto-numbering doesn't fight them). */
  renamed: boolean;
  /** Free-text scratchpad, persisted in config keyed by title. */
  note: string;
  /** Fired when this session's emulator buffer changes (repaint its view). */
  dataListeners: Set<() => void>;
}

/**
 * Notes live in ~/.destedtui/config.json under `termNotes`, keyed by session
 * title. Titles are unique at creation (claude 1, claude 2, …) and the note
 * follows a rename, so "claude 1"'s note is still there next time you open one.
 */
function readNotes(): Record<string, string> {
  const raw = readConfig().termNotes;
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

function writeNotes(notes: Record<string, string>): void {
  patchConfig({ termNotes: notes });
}

/** `claude` here means exactly what you type by hand. */
const CLAUDE_CMD = "claude --dangerously-skip-permissions";

/**
 * Your shell, with your whole profile — pwsh if you have it, else Windows
 * PowerShell. Resolved once; the pty sidecar spawns this exact path.
 */
const SHELL_FILE: string =
  Bun.which("pwsh") ?? Bun.which("pwsh.exe") ?? Bun.which("powershell") ?? Bun.which("powershell.exe") ?? "powershell.exe";

/**
 * Load the full profile (oh-my-posh, PSReadLine, aliases — "all my shit") but
 * keep the profile's auto-launch of the project picker from firing inside a
 * pane. The shell's own escape hatch (`shell/destedtui.ps1`) reads this.
 */
const SHELL_ENV: Record<string, string> = { DESTEDTUI_NO_AUTOSTART: "1" };

class TermManager {
  private host: PtyHost;
  private sessions = new Map<string, TermSession>();
  private globalListeners = new Set<() => void>();
  order: string[] = [];
  activeId: string | null = null;
  mode: Mode = "nav";
  /** Bumped on structural change (add/remove/active/mode/status) for the screen. */
  revision = 0;
  private seq = 0;
  private started = false;

  constructor() {
    this.host = new PtyHost({
      onData: (id, s) => {
        const sess = this.sessions.get(id);
        if (!sess) return;
        // The write callback fires once xterm has parsed the chunk, so the view
        // repaints against a settled buffer rather than mid-escape-sequence.
        sess.term.write(s, () => {
          for (const l of sess.dataListeners) l();
        });
      },
      onExit: (id, code) => {
        const sess = this.sessions.get(id);
        if (!sess) return;
        sess.status = "exited";
        sess.exitCode = code;
        this.bump();
      },
    });
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.host.start();
  }

  private bump(): void {
    this.revision++;
    for (const l of this.globalListeners) l();
  }

  /** Screen subscribes to structural changes; views subscribe per-session below. */
  subscribeGlobal(cb: () => void): () => void {
    this.globalListeners.add(cb);
    return () => this.globalListeners.delete(cb);
  }

  subscribeData(id: string, cb: () => void): () => void {
    const sess = this.sessions.get(id);
    sess?.dataListeners.add(cb);
    return () => sess?.dataListeners.delete(cb);
  }

  list(): TermSession[] {
    return this.order.map((id) => this.sessions.get(id)!).filter(Boolean);
  }

  get(id: string): TermSession | undefined {
    return this.sessions.get(id);
  }

  active(): TermSession | null {
    return this.activeId ? (this.sessions.get(this.activeId) ?? null) : null;
  }

  create(kind: TermKind, cwd: string, cols = 80, rows = 24): TermSession {
    this.ensureStarted();
    const id = `t${++this.seq}`;
    const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
    const n = this.order.filter((oid) => this.sessions.get(oid)?.kind === kind).length + 1;
    const title = kind === "claude" ? `claude ${n}` : `shell ${n}`;
    const sess: TermSession = {
      id,
      title,
      kind,
      cwd,
      term,
      cols,
      rows,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      renamed: false,
      note: readNotes()[title] ?? "",
      dataListeners: new Set(),
    };
    this.sessions.set(id, sess);
    this.order.push(id);
    this.activeId = id;
    this.mode = "input"; // a freshly created terminal wants your keystrokes

    // A plain shell just drops you at your prompt. A claude session launches it
    // as a startup command (-NoExit so the pane survives claude quitting, and so
    // it runs reliably *after* your profile finishes loading — writing the
    // command as keystrokes races a slow profile).
    const args =
      kind === "claude" ? ["-NoLogo", "-NoExit", "-Command", CLAUDE_CMD] : ["-NoLogo"];
    this.host.spawn({ id, file: SHELL_FILE, args, cwd, cols, rows, env: SHELL_ENV });

    this.bump();
    return sess;
  }

  setActive(id: string): void {
    if (!this.sessions.has(id)) return;
    this.activeId = id;
    this.bump();
  }

  /** Give a session a custom name; empty resets nothing (keeps the last name). */
  rename(id: string, title: string): void {
    const sess = this.sessions.get(id);
    if (!sess) return;
    const t = title.trim();
    if (!t) return;
    const old = sess.title;
    sess.title = t;
    sess.renamed = true;
    // Re-key the persisted note so it follows the new name.
    if (old !== t) {
      const notes = readNotes();
      if (notes[old] !== undefined) {
        notes[t] = notes[old]!;
        delete notes[old];
        writeNotes(notes);
      }
    }
    this.bump();
  }

  /** Set (and persist) this session's note; blank removes it from config. */
  setNote(id: string, note: string): void {
    const sess = this.sessions.get(id);
    if (!sess) return;
    sess.note = note;
    const notes = readNotes();
    if (note.trim()) notes[sess.title] = note;
    else delete notes[sess.title];
    writeNotes(notes);
    this.bump();
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.bump();
  }

  focused(id: string): boolean {
    return this.activeId === id && this.mode === "input";
  }

  write(id: string, data: string): void {
    const sess = this.sessions.get(id);
    if (!sess || sess.status !== "running") return;
    this.host.write(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    const sess = this.sessions.get(id);
    if (!sess) return;
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);
    if (sess.cols === c && sess.rows === r) return;
    sess.cols = c;
    sess.rows = r;
    sess.term.resize(c, r);
    this.host.resize(id, c, r);
  }

  close(id: string): void {
    const sess = this.sessions.get(id);
    if (!sess) return;
    this.host.kill(id);
    sess.term.dispose();
    this.sessions.delete(id);
    const at = this.order.indexOf(id);
    this.order = this.order.filter((oid) => oid !== id);
    if (this.activeId === id) {
      const next = this.order[Math.min(at, this.order.length - 1)];
      this.activeId = next ?? null;
      if (!next) this.mode = "nav";
    }
    this.bump();
  }

  closeAll(): void {
    for (const id of [...this.order]) {
      this.host.kill(id);
      this.sessions.get(id)?.term.dispose();
    }
    this.sessions.clear();
    this.order = [];
    this.activeId = null;
    this.mode = "nav";
    this.bump();
  }

  count(): number {
    return this.order.length;
  }
}

/**
 * NOTE on your shell: panes run **pwsh with your full profile** (oh-my-posh,
 * PSReadLine, aliases). `DESTEDTUI_NO_AUTOSTART=1` keeps the profile's own
 * project-picker auto-launch from firing inside a pane (see shell/destedtui.ps1).
 * Cleanup is guaranteed three ways: graceful quit tree-kills the sidecar
 * (`ptyhost.ts`), the sidecar tree-kills itself on stdin-EOF, and a PID watchdog
 * in `host.mjs` self-destructs if the TUI dies hard — verified: 0 orphans.
 */
export const term = new TermManager();
