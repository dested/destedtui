#!/usr/bin/env bun
// `keys` — Sal's API-key vault. Non-interactive first: Claude sessions drive it.
// No value ever reaches stdout except through `reveal --yes-print-secret` and
// `values --yes-print-secret`, and both refuse to run inside Claude Code.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";
import { clearClipboard, readClipboard } from "./lib/keys/win32.ts";
import { UserError } from "./lib/keys/errors.ts";
import { findKey, readVault, reuseGroups, VAULT_PATH, type ReuseGroup } from "./lib/keys/vault.ts";
import { DEFAULT_DAYS, getUsage } from "./lib/keys/usage/index.ts";
import { ago, buildView, money, sparkline, units, type Money, type UsageLine, type UsageView } from "./lib/keys/usage/view.ts";
import {
  adapterFor,
  addKey,
  addProvider,
  adminFor,
  importKeys,
  mintAbility,
  newKey,
  projectFromCwd,
  projectValues,
  removeAdmin,
  removeProvider,
  revokeKey,
  setAdmin,
  viewKeys,
  writeEnv,
  type EnvWriteResult,
  type KeyView,
  type StoreResult,
} from "./lib/keys/ops.ts";

const HELP = `keys — one vault for every AI API key (DPAPI-encrypted, ${VAULT_PATH})

usage:
  keys                                   open the Keys screen
  keys list [--project p] [--provider x] [--all] [--json]
  keys new <provider> [--project p] [--label l] [--env-file f] [--replace] [--no-env] [--json]
                                         mint a key when the provider allows it; otherwise
                                         open its console page and print the next step
  keys add <provider> [--project p] (--clipboard | --stdin) [--label l] [--env-file f] [--replace] [--no-env]
                                         store a key made in a console; --clipboard clears it after
  keys env <project> [--dry-run]         write the project's active keys into its .env
  keys revoke <id> [--local-only]        revoke on the provider (when possible), mark it, drop its .env line
  keys reuse [--json]                    the same key used by more than one project
  keys usage [--project p] [--provider x] [--days n] [--refresh] [--json]
                                         spend per project, most recent first (cached 15 min;
                                         a key shared by N projects shows as shared, never one's)
  keys import [--root dir] [--dry-run] [--json]
                                         scan every project's .env files and store what's there
  keys providers [--json]
  keys provider add <id> --name n --env-var VAR --console-url url [--alias VAR]...
  keys provider remove <id>
  keys admin list
  keys admin set <provider> (--clipboard | --stdin | --from-env VAR) [--meta k=v]...
  keys admin remove <provider>
  keys reveal <id> --yes-print-secret    print one value (never inside Claude Code)

--project defaults to the project folder you're standing in (under the projects root).
Values are never shown — fingerprints (sha256 prefix) only. The value never goes on argv.

exit codes: 0 ok · 1 usage / user error · 2 provider API error`;

// ─── arg parsing ─────────────────────────────────────────────────────────────

const BOOL_FLAGS = new Set([
  "json",
  "all",
  "replace",
  "no-env",
  "clipboard",
  "stdin",
  "dry-run",
  "local-only",
  "yes-print-secret",
  "help",
  "no-open",
  "refresh",
]);
const MULTI_FLAGS = new Set(["alias", "meta"]);

interface Parsed {
  positional: string[];
  flags: Map<string, string>;
  multi: Map<string, string[]>;
  bools: Set<string>;
}

function parse(argv: string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map(), multi: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h") {
      out.bools.add("help");
      continue;
    }
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (BOOL_FLAGS.has(name)) {
      out.bools.add(name);
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new UserError(`--${name} needs a value`);
    if (MULTI_FLAGS.has(name)) out.multi.set(name, [...(out.multi.get(name) ?? []), value]);
    else out.flags.set(name, value);
  }
  return out;
}

function need(p: Parsed, index: number, what: string): string {
  const v = p.positional[index];
  if (!v) throw new UserError(`missing ${what} — keys --help`);
  return v;
}

function project(p: Parsed): string {
  const explicit = p.flags.get("project");
  if (explicit) return explicit;
  const here = projectFromCwd(process.cwd());
  if (here) return here;
  throw new UserError("which project? pass --project <folder> (or run this inside the project)");
}

function insideClaude(): boolean {
  return Boolean(process.env.CLAUDECODE);
}

/** The secret input for add/admin set: clipboard or stdin, never argv. */
async function secretInput(p: Parsed): Promise<{ value: string; fromClipboard: boolean }> {
  if (p.bools.has("clipboard")) return { value: (await readClipboard()).trim(), fromClipboard: true };
  if (p.bools.has("stdin")) return { value: (await Bun.stdin.text()).trim(), fromClipboard: false };
  throw new UserError("pass --clipboard or --stdin (a key is never accepted as an argument)");
}

// ─── output ──────────────────────────────────────────────────────────────────

const out = (s = "") => console.log(s);
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function keyLine(k: KeyView): string {
  const where = `${k.envFile} ${k.envVar}`;
  const state = k.revokedAt ? `revoked ${k.revokedAt.slice(0, 10)}` : k.source;
  const label = k.label && k.label !== "imported" ? ` "${k.label}"` : "";
  return `  ${k.providerId.padEnd(11)} ${k.id}  fp ${k.fingerprint}  ${state.padEnd(9)} ${where}${label}`;
}

function printKeys(keys: KeyView[]): void {
  if (keys.length === 0) return out("no keys (keys import scans every project's .env; keys new <provider> makes one)");
  let last = "";
  for (const k of keys) {
    if (k.project !== last) {
      out(k.project);
      last = k.project;
    }
    out(keyLine(k));
    if (k.sharedWith.length) out(`    ⚠ same key in ${k.sharedWith.length + 1} projects — also ${k.sharedWith.join(", ")}`);
  }
}

function printReuse(groups: ReuseGroup[]): void {
  if (groups.length === 0) return out("no key is shared between projects");
  out(`${groups.length} key${groups.length === 1 ? "" : "s"} shared between projects:`);
  for (const g of groups) out(`  ⚠ ${g.providerId.padEnd(11)} fp ${g.fingerprint}  ${g.projects.length} projects: ${g.projects.join(", ")}`);
}

function printEnv(r: EnvWriteResult, dryRun: boolean): void {
  if (r.plans.length === 0) return out(`${r.project}: no active keys to write`);
  for (const plan of r.plans) {
    const changed = plan.changes.filter((c) => c.change !== "same");
    const verb = dryRun ? "would write" : "wrote";
    out(changed.length ? `${verb} ${plan.file}: ${changed.map((c) => `${c.change} ${c.envVar}`).join(", ")}` : `${plan.file}: up to date`);
  }
  for (const i of r.ignore) {
    if (i.added) out(`added ${i.file} to ${r.project}/.gitignore`);
    if (i.tracked) out(`⚠ ${r.project}/${i.file} is COMMITTED to git — .gitignore can't help; the keys in it are in history. git rm --cached it and rotate them.`);
  }
}

function printStored(r: StoreResult, verb: string): void {
  out(`✓ ${verb} ${r.key.providerId} key for ${r.key.project}: ${r.key.id}  fp ${r.key.fingerprint}${r.note ? `  (${r.note})` : ""}`);
  if (r.replaced) out(`  replaced ${r.replaced.id} (fp ${r.replaced.fingerprint}): ${r.replaced.remoteNote}`);
  if (r.env) printEnv(r.env, false);
}

function usageCells(m: Money | null, u: (Money & { unit: string }) | null): string[] {
  if (m) return [money(m.d24), money(m.today), money(m.window), sparkline(m.series)];
  if (u) return [units(u.d24, u.unit), units(u.today, u.unit), units(u.window, u.unit), sparkline(u.series)];
  return ["", "", "", ""];
}

function usageRow(label: string, cells: string[], tail: string, indent = ""): string {
  const [d24 = "", today = "", win = "", spark = ""] = cells;
  return `${indent}${label.length > 44 - indent.length ? `${label.slice(0, 43 - indent.length)}…` : label.padEnd(44 - indent.length)} ${d24.padStart(10)} ${today.padStart(10)} ${win.padStart(10)}  ${spark.padEnd(9)} ${tail}`;
}

function printUsage(v: UsageView, detail: boolean): void {
  out(`usage · last ${v.days} days · fetched ${ago(v.fetchedAt)} · 24h is estimated from UTC day buckets`);
  out(usageRow("", ["24h", "today", `${v.days}d`, `last ${v.days}d`], ""));
  if (v.lines.length === 0) out("  nothing reported for this window");
  for (const l of v.lines) {
    const marks = [l.allocated ? "allocated" : "", l.weekToDate ? "week-to-date" : "", l.lastUsedAt ? `used ${ago(l.lastUsedAt)}` : ""].filter(Boolean).join(", ");
    const label = l.kind === "shared" ? `⚠ ${l.label}` : l.label;
    out(usageRow(label, usageCells(l.usd, l.units), `${l.providers.join("+")}${marks ? `  (${marks})` : ""}`));
    if (detail || l.kind === "shared")
      for (const k of l.keys) {
        if (l.keys.length === 1 && !detail) break;
        const who = `${k.providerId} ${k.vaultKeyIds[0] ?? k.remoteKeyId ?? "account"}${k.name ? ` "${k.name}"` : ""}`;
        out(usageRow(who, usageCells(k.usd, k.units), k.matchedBy ? `matched by ${k.matchedBy}` : "", "    "));
      }
  }
  out(usageRow("total ($ only)", usageCells(v.total, null), ""));
  out();
  for (const pr of v.providers) {
    const state =
      pr.status === "ok" ? (pr.scope === "per-key" ? "✓ per key" : "✓ account only") : pr.status === "needs-admin" ? "needs admin key" : pr.status === "no-api" ? "no usage API" : "✗ error";
    out(`  ${pr.id.padEnd(11)} ${state}${pr.message ? ` — ${pr.message}` : ""}`);
  }
}

// ─── commands ────────────────────────────────────────────────────────────────

async function run(argv: string[]): Promise<number> {
  const p = parse(argv);
  const cmd = p.positional[0];
  const asJson = p.bools.has("json");

  if (p.bools.has("help") || cmd === "help") {
    out(HELP);
    return 0;
  }

  switch (cmd) {
    case "list":
    case "ls": {
      const keys = viewKeys(readVault(), { project: p.flags.get("project"), provider: p.flags.get("provider"), all: p.bools.has("all") });
      if (asJson) json(keys);
      else printKeys(keys);
      return 0;
    }

    case "new": {
      const provider = need(p, 1, "provider");
      const res = await newKey({
        provider,
        project: project(p),
        label: p.flags.get("label"),
        envFile: p.flags.get("env-file"),
        replace: p.bools.has("replace"),
        writeEnv: !p.bools.has("no-env"),
        openConsole: !p.bools.has("no-open"),
      });
      if (asJson) {
        json(res.kind === "minted" ? res : { kind: res.kind, provider: res.provider.id, url: res.url, reason: res.reason, adminHint: res.adminHint });
        return 0;
      }
      if (res.kind === "minted") {
        printStored(res, "minted");
        return 0;
      }
      const proj = project(p);
      out(
        res.reason === "console-only"
          ? `${res.provider.name} has no API for creating keys — opened ${res.url}`
          : `no admin credential for ${res.provider.name} yet — opened ${res.url}`,
      );
      out(`next: create a key named "${proj}" there and copy it, then run:`);
      out(`  keys add ${res.provider.id} --project ${proj} --clipboard`);
      if (res.adminHint) out(`to mint next time instead: ${res.adminHint}`);
      return 0;
    }

    case "add": {
      const provider = need(p, 1, "provider");
      const proj = project(p);
      const secret = await secretInput(p);
      const res = await addKey(
        { provider, project: proj, label: p.flags.get("label"), envFile: p.flags.get("env-file"), replace: p.bools.has("replace"), writeEnv: !p.bools.has("no-env") },
        secret.value,
      );
      if (secret.fromClipboard) await clearClipboard();
      if (asJson) json(res);
      else {
        printStored(res, "stored");
        if (secret.fromClipboard) out("  clipboard cleared");
      }
      return 0;
    }

    case "env": {
      const proj = p.positional[1] ?? project(p);
      const dryRun = p.bools.has("dry-run");
      const res = await writeEnv(proj, dryRun);
      if (asJson) json(res);
      else printEnv(res, dryRun);
      return 0;
    }

    case "revoke": {
      const res = await revokeKey(need(p, 1, "key id"), { localOnly: p.bools.has("local-only") });
      if (asJson) json(res);
      else {
        out(`✓ revoked ${res.id} (${res.project}, fp ${res.fingerprint}) — ${res.remoteNote}`);
        if (res.envRemoved) out(`  removed its line from ${res.project}'s env file`);
      }
      return 0;
    }

    case "usage": {
      const raw = p.flags.get("days");
      const days = raw === undefined ? DEFAULT_DAYS : Number.parseInt(raw, 10);
      if (!Number.isInteger(days) || days < 1 || days > 31) throw new UserError("--days wants 1–31");
      const cache = await getUsage({ days, refresh: p.bools.has("refresh") });
      const view = buildView(cache, readVault(), { days, project: p.flags.get("project"), provider: p.flags.get("provider")?.toLowerCase() });
      if (asJson) json(view);
      else printUsage(view, Boolean(p.flags.get("project")));
      return 0;
    }

    case "reuse": {
      const groups = reuseGroups(readVault());
      if (asJson) json(groups);
      else printReuse(groups);
      return 0;
    }

    case "import": {
      const dryRun = p.bools.has("dry-run");
      const report = await importKeys({ root: p.flags.get("root"), dryRun });
      if (asJson) {
        json(report);
        return 0;
      }
      out(`scanned ${report.filesScanned} env files · ${report.found} keys found · ${report.imported.length} ${dryRun ? "would be " : ""}imported · ${report.known} already known`);
      for (const i of report.imported) out(`  + ${i.project.padEnd(24)} ${i.providerId.padEnd(11)} fp ${i.fingerprint}  ${i.file} ${i.envVar}`);
      if (report.conflicts.length) {
        out(`${report.conflicts.length} not stored (a different key for the same provider is already this project's):`);
        for (const c of report.conflicts) out(`  ! ${c.project.padEnd(24)} ${c.providerId.padEnd(11)} fp ${c.fingerprint}  ${c.file} ${c.envVar}  (kept ${c.kept})`);
      }
      out();
      printReuse(report.reuse);
      return 0;
    }

    case "providers": {
      const v = readVault();
      const rows = v.providers.map((pr) => ({
        id: pr.id,
        name: pr.name,
        envVar: pr.envVar,
        consoleUrl: pr.consoleUrl,
        builtin: pr.builtin,
        mint: mintAbility(v, pr),
        admin: adminFor(v, pr)?.source ?? null,
        revokes: Boolean(adapterFor(pr)?.revoke),
      }));
      if (asJson) json(rows);
      else
        for (const r of rows) {
          const how = r.mint === "mint" ? `mints (admin from ${r.admin})` : r.mint === "no-admin" ? "can mint — needs admin credential" : r.revokes ? "console only · revoke via admin API" : "console only";
          out(`${r.id.padEnd(11)} ${r.envVar.padEnd(22)} ${how.padEnd(36)} ${r.consoleUrl}${r.builtin ? "" : "  (custom)"}`);
        }
      return 0;
    }

    case "provider": {
      const sub = need(p, 1, "add | remove");
      if (sub === "add") {
        const id = need(p, 2, "provider id");
        const name = p.flags.get("name") ?? id;
        const envVar = p.flags.get("env-var");
        const consoleUrl = p.flags.get("console-url");
        if (!envVar || !consoleUrl) throw new UserError("provider add needs --env-var and --console-url");
        const created = await addProvider({ id, name, envVar, consoleUrl, aliases: p.multi.get("alias") });
        out(`✓ added provider ${created.id} (${created.envVar}) — console only`);
        return 0;
      }
      if (sub === "remove") {
        await removeProvider(need(p, 2, "provider id"));
        out("✓ removed");
        return 0;
      }
      throw new UserError(`unknown: keys provider ${sub}`);
    }

    case "admin": {
      const sub = need(p, 1, "list | set | remove");
      if (sub === "list") {
        const v = readVault();
        for (const pr of v.providers) {
          const adapter = adapterFor(pr);
          if (!adapter) continue;
          const stored = v.admin.find((a) => a.providerId === pr.id);
          const src = adminFor(v, pr);
          const meta = stored && Object.keys(stored.meta).length ? `  meta ${Object.entries(stored.meta).map(([k, val]) => `${k}=${val}`).join(" ")}` : "";
          const state = stored ? `vault fp ${stored.fingerprint}${meta}` : src ? `from $env:${adapter.adminEnvVar}` : `none — ${adapter.adminKind} at ${adapter.adminConsoleUrl}`;
          out(`${pr.id.padEnd(11)} ${state}`);
        }
        return 0;
      }
      if (sub === "set") {
        const provider = need(p, 2, "provider");
        const meta: Record<string, string> = {};
        for (const kv of p.multi.get("meta") ?? []) {
          const i = kv.indexOf("=");
          if (i <= 0) throw new UserError(`--meta wants key=value, got "${kv}"`);
          meta[kv.slice(0, i)] = kv.slice(i + 1);
        }
        const fromEnv = p.flags.get("from-env");
        let value: string;
        let fromClipboard = false;
        if (fromEnv) {
          const v = process.env[fromEnv];
          if (!v) throw new UserError(`$env:${fromEnv} is not set in this shell`);
          value = v;
        } else {
          const s = await secretInput(p);
          value = s.value;
          fromClipboard = s.fromClipboard;
        }
        const res = await setAdmin(provider, value, meta);
        if (fromClipboard) await clearClipboard();
        out(`✓ admin credential for ${provider} stored (fp ${res.fingerprint})${fromClipboard ? " · clipboard cleared" : ""}`);
        return 0;
      }
      if (sub === "remove") {
        out((await removeAdmin(need(p, 2, "provider"))) ? "✓ removed" : "nothing stored for that provider");
        return 0;
      }
      throw new UserError(`unknown: keys admin ${sub}`);
    }

    case "reveal": {
      if (!p.bools.has("yes-print-secret")) throw new UserError("reveal prints a secret — add --yes-print-secret if you really mean it");
      if (insideClaude()) throw new UserError("refusing: reveal never runs inside Claude Code (secrets don't go in transcripts)");
      out(findKey(readVault(), need(p, 1, "key id")).value);
      return 0;
    }

    case "values": {
      // For the PowerShell Use-Keys helper: JSON {VAR: value} on stdout, straight into $env:.
      if (!p.bools.has("yes-print-secret")) throw new UserError("values prints secrets — it exists for Use-Keys; add --yes-print-secret");
      if (insideClaude()) throw new UserError("refusing: values never runs inside Claude Code (secrets don't go in transcripts)");
      console.log(JSON.stringify(projectValues(p.positional[1] ?? project(p))));
      return 0;
    }

    case "tui":
    case undefined:
      return -1;

    default:
      throw new UserError(`unknown command "${cmd}" — keys --help`);
  }
}

let code: number;
try {
  code = await run(process.argv.slice(2));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`keys: ${msg}`);
  process.exit(err instanceof UserError ? 1 : 2);
}

if (code === -1) {
  if (!process.stdout.isTTY) {
    out(HELP);
    process.exit(0);
  }
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  createRoot(renderer).render(<App initialRoute={{ name: "keys" }} cwd={process.cwd()} />);
} else {
  process.exit(code);
}
