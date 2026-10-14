import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IS_LINUX, LINUX_DEFAULT_ROOT, winHome } from "./platform.ts";

export const CONFIG_DIR = join(homedir(), ".destedtui");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Narrow anything JSON-shaped to a plain object we can read keys off. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Whole config object, or {} when there is no config yet / it's unreadable. */
export function readConfig(): Record<string, unknown> {
  if (IS_LINUX && !existsSync(CONFIG_PATH)) seedFromWindows();
  return readJsonFile(CONFIG_PATH);
}

/** Shallow-merge a patch into the config file, preserving every other key. */
export function patchConfig(patch: Record<string, unknown>): void {
  const next = { ...readConfig(), ...patch };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}

/**
 * The Linux build keeps its own config, but a fresh one shouldn't start cold:
 * the first run copies the Windows config's command shortcuts, localhost
 * Postgres preset and picker frecency (re-keyed from `g:/code/<name>` to
 * `/w/code/<name>`, project names only). Runs once: the file it writes is the
 * marker.
 */
function seedFromWindows(): void {
  const win = readJsonFile(join(winHome(), ".destedtui", "config.json"));
  const seed: Record<string, unknown> = { seededFrom: Object.keys(win).length > 0 ? "windows" : null };
  if (Array.isArray(win.commands)) seed.commands = win.commands;
  if (isRecord(win.localhost)) seed.localhost = win.localhost;
  if (isRecord(win.projectOpens)) {
    const winRoot = (typeof win.projectsRoot === "string" && win.projectsRoot ? win.projectsRoot : "G:\\code")
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    const opens: Record<string, unknown> = {};
    for (const [key, stat] of Object.entries(win.projectOpens)) {
      if (!key.startsWith(`${winRoot}/`)) continue;
      const name = key.slice(winRoot.length + 1);
      if (!name || name.includes("/")) continue;
      opens[`${LINUX_DEFAULT_ROOT}/${name}`] = stat;
    }
    seed.projectOpens = opens;
  }
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2));
  } catch {
    /* read-only home: run unseeded */
  }
}
