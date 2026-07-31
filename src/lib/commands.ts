import { isRecord, patchConfig, readConfig } from "./config.ts";
import { fuzzyMatch, type Match } from "./fuzzy.ts";

/**
 * A named shortcut for something you run all day. It runs in whatever directory
 * the shell is already in — these are tools, not project actions, so the picker
 * never cds for them.
 */
export interface CommandShortcut {
  name: string;
  command: string;
}

/** Seeded on first run so the feature is discoverable instead of an empty idea. */
const DEFAULTS: CommandShortcut[] = [{ name: "cc", command: "bunx ccusage" }];

/** A name has to be typeable in the filter line, and unique. */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

function parse(value: unknown): CommandShortcut[] | null {
  if (!Array.isArray(value)) return null;
  const list: CommandShortcut[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { name, command } = entry;
    if (typeof name !== "string" || typeof command !== "string") continue;
    const clean = normalizeName(name);
    if (!clean || !command.trim()) continue;
    if (list.some((c) => c.name === clean)) continue;
    list.push({ name: clean, command: command.trim() });
  }
  return list;
}

/**
 * Saved shortcuts. A missing `commands` key means "never configured" and gets
 * the defaults; an empty array means you deleted them all and is respected.
 */
export function loadCommands(): CommandShortcut[] {
  const raw = readConfig().commands;
  if (raw === undefined) return [...DEFAULTS];
  return parse(raw) ?? [...DEFAULTS];
}

export function saveCommands(commands: CommandShortcut[]): void {
  patchConfig({ commands });
}

/**
 * Add or rename-in-place. `replacing` is the name being edited, so an edit that
 * keeps its position doesn't jump to the end of the list.
 */
export function upsertCommand(
  commands: CommandShortcut[],
  next: CommandShortcut,
  replacing: string | null,
): CommandShortcut[] {
  const name = normalizeName(next.name);
  const entry: CommandShortcut = { name, command: next.command.trim() };
  const at = replacing ? commands.findIndex((c) => c.name === replacing) : -1;
  const without = commands.filter((c) => c.name !== name && c.name !== replacing);
  if (at < 0) return [...without, entry];
  without.splice(Math.min(at, without.length), 0, entry);
  return without;
}

export function removeCommand(commands: CommandShortcut[], name: string): CommandShortcut[] {
  return commands.filter((c) => c.name !== name);
}

/**
 * Same shape as `matchProject`, with one deliberate difference: a shortcut you
 * typed exactly wins outright (`cc` is a two-letter name and would otherwise
 * lose to any project with a longer, higher-scoring hit).
 */
export function matchCommand(shortcut: CommandShortcut, q: string): Match | null {
  if (!q) return { score: 0, positions: [] };

  const name = fuzzyMatch(shortcut.name, q);
  const nameScore = name ? name.score + (shortcut.name === q ? 4000 : shortcut.name.startsWith(q) ? 400 : 0) : 0;
  const body = fuzzyMatch(shortcut.command, q);
  const bodyScore = body ? body.score * 0.5 : 0;

  if (nameScore <= 0 && bodyScore <= 0) return null;
  return nameScore >= bodyScore
    ? { score: nameScore, positions: name?.positions ?? [] }
    : { score: bodyScore, positions: [] };
}
