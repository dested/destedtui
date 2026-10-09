// ~/.bx/profiles: one Chrome user-data-dir per bx profile, never cleaned up by
// bx itself (460 dirs, 41 GB on 2026-10-08). Sizing them walks ~800k files
// (~13s), so it runs in bxProfilesWorker.ts. This module holds the fs work and
// the message contract between the screen and the worker; both ends zod-check it.

import { existsSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const BX_DIR = path.join(os.homedir(), ".bx");
export const PROFILES_DIR = path.join(BX_DIR, "profiles");
const RUN_DIR = path.join(BX_DIR, "run");
const LOGS_DIR = path.join(BX_DIR, "logs");
/** bx's own default (`--profile` omitted). Never pruned in bulk: it's the one a person signs into. */
export const DEFAULT_PROFILE = "default";
const TOP_N = 6;

export const ProfileInfoSchema = z.object({
  name: z.string(),
  bytes: z.number(),
  files: z.number(),
  /** newest of Local State, Default/Preferences, the dir itself and the bx log; 0 when none could be read */
  lastUsed: z.number(),
  /** the biggest top-level entries, largest first */
  top: z.array(z.object({ name: z.string(), bytes: z.number() })),
  logBytes: z.number(),
});
export type ProfileInfo = z.infer<typeof ProfileInfoSchema>;

export const ProfileReqSchema = z.discriminatedUnion("type", [
  /** no names = every profile, announced first with `listed` */
  z.object({ type: z.literal("scan"), names: z.array(z.string()).optional() }),
  z.object({ type: z.literal("delete"), names: z.array(z.string()) }),
]);
export type ProfileReq = z.infer<typeof ProfileReqSchema>;

export const ProfileMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("listed"), names: z.array(z.string()) }),
  z.object({ type: z.literal("sized"), info: ProfileInfoSchema }),
  z.object({ type: z.literal("gone"), name: z.string() }),
  z.object({ type: z.literal("scanned"), ms: z.number(), full: z.boolean() }),
  /** error null = deleted */
  z.object({ type: z.literal("deleted"), name: z.string(), error: z.string().nullable() }),
  z.object({ type: z.literal("deleteDone") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ProfileMsg = z.infer<typeof ProfileMsgSchema>;

const SAFE_NAME = /^[^\\/:*?"<>|\0]+$/;

/** The profile's folder, or null for anything that isn't a plain child of PROFILES_DIR. Every rm goes through this. */
export function profileDir(name: string): string | null {
  if (!SAFE_NAME.test(name) || name === "." || name === "..") return null;
  const dir = path.join(PROFILES_DIR, name);
  return path.dirname(dir) === PROFILES_DIR ? dir : null;
}

const logFile = (name: string): string => path.join(LOGS_DIR, `${name}.log`);
const runFile = (name: string): string => path.join(RUN_DIR, `${name}.json`);

export async function listProfiles(): Promise<string[]> {
  try {
    const entries = await readdir(PROFILES_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Bytes and entries under a folder. Never follows links; unreadable entries count as 0. */
async function walk(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    const from = d;
    const sizes = await Promise.all(
      entries.map((e) => {
        const p = path.join(from, e.name);
        if (e.isDirectory()) {
          stack.push(p);
          return 0;
        }
        return lstat(p).then(
          (s) => s.size,
          () => 0,
        );
      }),
    );
    for (const s of sizes) bytes += s;
    files += entries.length;
  }
  return { bytes, files };
}

const mtime = (p: string): Promise<number> =>
  stat(p).then(
    (s) => s.mtimeMs,
    () => 0,
  );

export async function sizeProfile(name: string): Promise<ProfileInfo | null> {
  const dir = profileDir(name);
  if (!dir) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let bytes = 0;
  let files = 0;
  const top: { name: string; bytes: number }[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const r = e.isDirectory()
      ? await walk(p)
      : {
          bytes: await lstat(p).then(
            (s) => s.size,
            () => 0,
          ),
          files: 1,
        };
    bytes += r.bytes;
    files += r.files;
    top.push({ name: e.name, bytes: r.bytes });
  }
  top.sort((a, b) => b.bytes - a.bytes);
  // Chrome rewrites Local State and Default/Preferences on every run; the log is bx's own.
  const [lastUsed = 0, logBytes = 0] = await Promise.all([
    Promise.all([path.join(dir, "Local State"), path.join(dir, "Default", "Preferences"), dir, logFile(name)].map(mtime)).then((ts) => Math.max(0, ...ts)),
    stat(logFile(name)).then(
      (s) => s.size,
      () => 0,
    ),
  ]);
  return { name, bytes, files, lastUsed, top: top.slice(0, TOP_N), logBytes };
}

// ─── the screen's cache (UI thread only) ────────────────────────────────────────

/** Survives leaving the profiles screen, so coming back paints the last sizes while a fresh scan runs. */
export const profileCache: { known: Map<string, ProfileInfo>; listed: string[] | null; measured: boolean } = {
  known: new Map(),
  listed: null,
  measured: false,
};

/** What the bx screen's button shows: null until a scan has measured every profile. */
export function profilesTotal(): { count: number; bytes: number } | null {
  const { known, listed, measured } = profileCache;
  if (!measured || !listed) return null;
  let bytes = 0;
  for (const p of known.values()) bytes += p.bytes;
  return { count: listed.length, bytes };
}

/** Removes the profile folder and its bx log. Returns why it couldn't, or null. Refuses while a daemon's run file exists. */
export async function deleteProfile(name: string): Promise<string | null> {
  const dir = profileDir(name);
  if (!dir) return "not a profile name";
  if (existsSync(runFile(name))) return "a daemon is running on it";
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  await rm(logFile(name), { force: true }).catch(() => undefined);
  return existsSync(dir) ? "only partly deleted: something still holds files in it" : null;
}
