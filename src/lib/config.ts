import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".destedtui");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Whole config object, or {} when there is no config yet / it's unreadable. */
export function readConfig(): Record<string, any> {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
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
