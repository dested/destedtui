import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Named snapshots of one Windows Terminal window's tabs (features/tabs.md).
// One JSON file per name in sals-powershell-setup (gitignored there), so a
// snapshot outlives a reboot and this repo's checkout. Zod on every read.

/** Where snapshots live. TABS_DIR overrides it (tests). */
export const TABS_DIR = process.env.TABS_DIR || "G:\\code\\sals-powershell-setup\\claude\\sessions";

const base = {
  /** 0-based position in the window when saved */
  index: z.number().int().nonnegative(),
  /** the tab title with leading status glyphs stripped ("🔔 clever" → "clever") */
  title: z.string(),
  /** the tab title exactly as Windows Terminal showed it */
  rawTitle: z.string(),
  platform: z.enum(["windows", "wsl"]),
  /** Windows path for windows tabs, Linux path (/w/code/…) for wsl tabs */
  cwd: z.string(),
};

export const SavedTabSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("claude"),
    sessionId: z.string(),
    /** Claude Code's session name (`destedtui-0f`), "" when it had none */
    sessionName: z.string(),
    /** the last real prompt typed into the session, first 160 chars */
    lastPrompt: z.string(),
  }),
  z.object({ ...base, kind: z.literal("shell") }),
  z.object({
    ...base,
    kind: z.literal("app"),
    /** pwsh: the process's own command line; wsl: its argv, shell-quoted */
    command: z.string(),
  }),
]);
export type SavedTab = z.infer<typeof SavedTabSchema>;
/** A tab before it has a place and a title: what a pane turned out to be running. */
export type TabDetail = SavedTab extends infer U ? (U extends SavedTab ? Omit<U, "index" | "title" | "rawTitle"> : never) : never;

export const SnapshotSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  /** ISO time */
  savedAt: z.string(),
  window: z.object({ hwnd: z.number().int(), tabCount: z.number().int().nonnegative() }),
  tabs: z.array(SavedTabSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkName(name: string): string | null {
  if (!NAME_RE.test(name)) return `"${name}" isn't a snapshot name: letters, digits, . _ - (up to 64), starting with a letter or digit`;
  return null;
}

export function snapshotPath(name: string): string {
  return join(TABS_DIR, `${name}.json`);
}

/** Writes atomically; returns whether a snapshot of that name was replaced. */
export function writeSnapshot(snap: Snapshot): { path: string; replaced: boolean } {
  const bad = checkName(snap.name);
  if (bad) throw new Error(bad);
  mkdirSync(TABS_DIR, { recursive: true });
  const path = snapshotPath(snap.name);
  const replaced = existsSync(path);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(SnapshotSchema.parse(snap), null, 2)}\n`);
  renameSync(tmp, path);
  return { path, replaced };
}

export type ReadResult = { ok: true; snap: Snapshot } | { ok: false; error: string };

export function readSnapshot(name: string): ReadResult {
  const path = snapshotPath(name);
  if (!existsSync(path)) return { ok: false, error: `no snapshot named "${name}" (${path})` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `${path} isn't a v1 tabs snapshot: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  return { ok: true, snap: parsed.data };
}

export interface SnapshotEntry {
  name: string;
  path: string;
  /** null when the file doesn't parse */
  snap: Snapshot | null;
  error: string | null;
  mtime: number;
}

/** Every snapshot, newest first. Broken files are listed with their error. */
export function listSnapshots(): SnapshotEntry[] {
  if (!existsSync(TABS_DIR)) return [];
  const out: SnapshotEntry[] = [];
  for (const file of readdirSync(TABS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    const path = join(TABS_DIR, file);
    const r = readSnapshot(name);
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // vanished between readdir and stat
    }
    out.push({ name, path, snap: r.ok ? r.snap : null, error: r.ok ? null : r.error, mtime });
  }
  const when = (e: SnapshotEntry) => (e.snap ? Date.parse(e.snap.savedAt) : e.mtime);
  return out.sort((a, b) => when(b) - when(a));
}

export function removeSnapshot(name: string): boolean {
  const path = snapshotPath(name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
