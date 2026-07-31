import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".destedtui");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Narrow anything JSON-shaped to a plain object we can read keys off. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whole config object, or {} when there is no config yet / it's unreadable. */
export function readConfig(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Shallow-merge a patch into the config file, preserving every other key. */
export function patchConfig(patch: Record<string, unknown>): void {
  const next = { ...readConfig(), ...patch };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}
