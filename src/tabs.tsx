#!/usr/bin/env bun
// `tabs` — named snapshots of one Windows Terminal window's tabs, restorable
// into the current window after a reboot. features/tabs.md.
//
//   tabs save <name>            capture the window you run it from
//   tabs restore [name]         pick tabs in a TUI and reopen them (--all / --dry-run skip it)
//   tabs list | rm <name> | show <name> [--json]
//
// Windows only underneath (UI Automation, consoles, wt.exe); the Linux bin
// forwards here with its tty in TABS_SELF_TTY.

import { capture, CaptureError } from "./lib/tabs/capture.ts";
import { checkName, listSnapshots, readSnapshot, removeSnapshot, TABS_DIR, writeSnapshot, type SavedTab, type Snapshot } from "./lib/tabs/store.ts";
import { openCount, quoteArg, restoreRows, runWt, tabArgs, wtArgs, type Choice } from "./lib/tabs/restore.ts";
import { pad } from "./lib/text.ts";
import { kindCounts, savedLabel } from "./lib/tabs/format.ts";

const HELP = `tabs — save the tabs of this Windows Terminal window, bring them back later

usage:
  tabs                          pick a snapshot, then its tabs, in the TUI
  tabs save <name>              capture this window's tabs (overwrites <name>)
  tabs restore [name]           the TUI on that snapshot: tick tabs, enter reopens them here
  tabs restore <name> --all     reopen every claude + shell tab without the TUI (no apps)
  tabs restore <name> --dry-run print the wt command instead of running it (the --all set)
  tabs list [--json]            every snapshot: name, saved, tabs
  tabs show <name> [--json]     one snapshot's tabs
  tabs rm <name>                delete a snapshot

snapshots: ${TABS_DIR}\\<name>.json
shell: save-sessions <name> = tabs save, restore-sessions [name] = tabs restore`;

class UserError extends Error {}

interface Parsed {
  positional: string[];
  bools: Set<string>;
  values: Map<string, string>;
}

const VALUE_FLAGS = new Set(["hwnd"]);

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const bools = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-h") bools.add("help");
    else if (a.startsWith("--")) {
      const [k = "", inline] = a.slice(2).split("=", 2);
      if (VALUE_FLAGS.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new UserError(`--${k} needs a value`);
        values.set(k, v);
      } else bools.add(k);
    } else positional.push(a);
  }
  return { positional, bools, values };
}

const out = (s: string) => console.log(s);

function detailOf(t: SavedTab): string {
  if (t.kind === "claude") return `${t.sessionId.slice(0, 8)}  ${t.lastPrompt ? `“${t.lastPrompt.slice(0, 60)}”` : ""}`;
  if (t.kind === "app") return t.command;
  return "";
}

function table(tabs: SavedTab[]): string {
  const titleW = Math.min(26, Math.max(5, ...tabs.map((t) => t.title.length)));
  const cwdW = Math.min(44, Math.max(3, ...tabs.map((t) => t.cwd.length)));
  const head = `${"#".padStart(2)}  ${pad("title", titleW)}  ${pad("on", 3)}  ${pad("kind", 6)}  ${pad("cwd", cwdW)}  detail`;
  const lines = tabs.map(
    (t) => `${String(t.index + 1).padStart(2)}  ${pad(t.title, titleW)}  ${pad(t.platform === "wsl" ? "wsl" : "win", 3)}  ${pad(t.kind, 6)}  ${pad(t.cwd, cwdW)}  ${detailOf(t)}`,
  );
  return [head, ...lines].join("\n");
}

function needName(p: Parsed, verb: string): string {
  const name = p.positional[1];
  if (!name) throw new UserError(`tabs ${verb} <name>`);
  const bad = checkName(name);
  if (bad) throw new UserError(bad);
  return name;
}

function load(name: string): Snapshot {
  const r = readSnapshot(name);
  if (!r.ok) throw new UserError(r.error);
  return r.snap;
}

async function save(p: Parsed): Promise<number> {
  const name = needName(p, "save");
  const hwndRaw = p.values.get("hwnd");
  const hwnd = hwndRaw === undefined ? undefined : Number(hwndRaw);
  if (hwnd !== undefined && !Number.isInteger(hwnd)) throw new UserError(`--hwnd ${hwndRaw} isn't a window handle`);
  const cap = await capture({ hwnd }).catch((err: unknown) => {
    throw err instanceof CaptureError ? new UserError(err.message) : err;
  });
  const snap: Snapshot = { version: 1, name, savedAt: new Date().toISOString(), window: cap.window, tabs: cap.tabs };
  const { path, replaced } = writeSnapshot(snap);
  if (p.bools.has("json")) {
    out(JSON.stringify({ path, replaced, snapshot: snap, skipped: cap.skipped, unmapped: cap.unmapped, warnings: cap.warnings }, null, 2));
    return 0;
  }
  out(table(cap.tabs));
  out("");
  out(`${replaced ? "replaced" : "saved"} ${name}: ${cap.tabs.length} of ${cap.window.tabCount} tabs (${kindCounts(cap.tabs)}) → ${path}`);
  const self = cap.unmapped.filter((u) => u.self);
  const lost = cap.unmapped.filter((u) => !u.self);
  if (self.length) out(`skipped this tab (${self.map((u) => `#${u.index + 1}`).join(", ")}): it's the one running tabs save`);
  if (lost.length) out(`${lost.length} tab${lost.length === 1 ? "" : "s"} couldn't be matched to a pane (renamed tab or app holding the title?): ${lost.map((u) => `#${u.index + 1} ${u.title}`).join(", ")}`);
  const skippedPanes = cap.skipped.otherWindow + cap.skipped.hidden;
  if (skippedPanes) out(`${skippedPanes} panes not in this window / in splits, skipped (${cap.skipped.otherWindow} in other windows, ${cap.skipped.hidden} not on any tab)`);
  for (const w of cap.warnings) out(`⚠ ${w}`);
  return cap.warnings.length ? 2 : 0;
}

function list(p: Parsed): number {
  const all = listSnapshots();
  if (p.bools.has("json")) {
    out(JSON.stringify(all.map((e) => ({ name: e.name, path: e.path, savedAt: e.snap?.savedAt ?? null, tabs: e.snap?.tabs.length ?? null, error: e.error }))));
    return 0;
  }
  if (all.length === 0) {
    out(`no snapshots in ${TABS_DIR} — tabs save <name>`);
    return 0;
  }
  const nameW = Math.max(4, ...all.map((e) => e.name.length));
  const now = Date.now();
  for (const e of all)
    out(e.snap ? `${pad(e.name, nameW)}  ${pad(savedLabel(e.snap.savedAt, now), 26)}  ${e.snap.tabs.length} tabs  (${kindCounts(e.snap.tabs)})` : `${pad(e.name, nameW)}  ✗ ${e.error}`);
  return 0;
}

function show(p: Parsed): number {
  const snap = load(needName(p, "show"));
  if (p.bools.has("json")) {
    out(JSON.stringify(snap, null, 2));
    return 0;
  }
  out(`${snap.name}: saved ${savedLabel(snap.savedAt, Date.now())}, ${snap.tabs.length} tabs of ${snap.window.tabCount} (${kindCounts(snap.tabs)})`);
  out("");
  out(table(snap.tabs));
  return 0;
}

/** --all / --dry-run: every claude + shell tab whose transcript is still there, no apps. */
function defaultChoices(snap: Snapshot): { choices: Choice[]; missing: SavedTab[] } {
  const rows = restoreRows(snap.tabs);
  return { choices: rows.map((r) => ({ tab: r.tab, on: r.defaultOn && r.tab.kind !== "app" })), missing: rows.filter((r) => r.transcriptMissing).map((r) => r.tab) };
}

async function restore(p: Parsed): Promise<number> {
  const name = p.positional[1];
  const dry = p.bools.has("dry-run");
  if (!dry && !p.bools.has("all")) return -1;
  if (!name) throw new UserError("tabs restore <name> --all|--dry-run (no name opens the picker)");
  const snap = load(name);
  const { choices, missing } = defaultChoices(snap);
  for (const t of missing) out(`⚠ #${t.index + 1} ${t.title}: transcript missing for ${t.kind === "claude" ? t.sessionId : "?"}, left out`);
  const args = wtArgs(choices);
  if (dry) {
    for (const c of choices) {
      const a = tabArgs(c);
      out(`#${c.tab.index + 1} ${c.tab.title}: ${a ? a.map(quoteArg).join(" ") : "(not opened)"}`);
    }
    out("");
    out(`wt ${args.map(quoteArg).join(" ")}`);
    return 0;
  }
  const n = openCount(choices);
  if (n === 0) throw new UserError(`nothing to open in ${name}`);
  const r = await runWt(args);
  if (!r.ok) throw new UserError(r.error ?? "wt failed");
  out(`✓ restored ${n} tabs from ${name}`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const p = parse(argv);
  if (p.bools.has("help")) {
    out(HELP);
    return 0;
  }
  switch (p.positional[0]) {
    case "save":
      return save(p);
    case "list":
    case "ls":
      return list(p);
    case "show":
      return show(p);
    case "rm": {
      const name = needName(p, "rm");
      if (!removeSnapshot(name)) throw new UserError(`no snapshot named "${name}"`);
      out(`removed ${name}`);
      return 0;
    }
    case "restore":
      return restore(p);
    case undefined:
      return -1;
    default:
      throw new UserError(`unknown command "${p.positional[0]}" — tabs --help`);
  }
}

let code: number;
try {
  code = await run(process.argv.slice(2));
} catch (err) {
  console.error(`tabs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(err instanceof UserError ? 1 : 2);
}

if (code === -1) {
  if (!process.stdout.isTTY) {
    out(HELP);
    process.exit(0);
  }
  const snapshot = process.argv.slice(2)[0] === "restore" ? parse(process.argv.slice(2)).positional[1] : undefined;
  const { bootTui } = await import("./tui.tsx");
  await bootTui({ name: "tabs", snapshot });
} else {
  process.exit(code);
}
