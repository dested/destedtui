// `keys import`: find every AI key already sitting in a .env under the projects
// root, so the vault starts out knowing the mess. Shallow on purpose: each
// project's top level plus two levels down (apps/web/.env), skipping the same
// dirs discovery skips.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isEnvFile, parseEnv, SKIP_DIRS } from "../discovery.ts";
import { fingerprint, type Provider } from "./vault.ts";

export interface Finding {
  project: string;
  /** Path inside the project, forward slashes (".env", "web/.env.local"). */
  file: string;
  envVar: string;
  providerId: string;
  value: string;
  fingerprint: string;
}

const PLACEHOLDER = /^(your|my|enter|insert|replace|changeme|xxx|todo|<|\.\.\.|sk-\.\.\.|placeholder|dummy|test|example|none|null|undefined)/i;

function looksReal(value: string): boolean {
  if (value.length < 16) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (/x{6,}|\*{4,}|\$\{/.test(value)) return false;
  return !/\s/.test(value);
}

/** The provider a (var, value) pair belongs to, or undefined. Var names win over value prefixes. */
export function classify(providers: Provider[], envVar: string, value: string): Provider | undefined {
  const upper = envVar.toUpperCase();
  if (upper.includes("ADMIN") || upper.includes("MANAGEMENT")) return undefined; // admin creds never go in the key list
  for (const p of providers) {
    for (const name of [p.envVar, ...p.aliases]) if (upper === name || upper.endsWith(`_${name}`)) return p;
  }
  if (!/(^|_)(API_?KEY|TOKEN|KEY|SECRET)$/.test(upper)) return undefined;
  const byPrefix = providers
    .flatMap((p) => p.prefixes.map((prefix) => ({ p, prefix })))
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find(({ prefix }) => value.startsWith(prefix));
  if (byPrefix) return byPrefix.p;
  const parts = upper.split("_");
  return providers.find((p) => parts.includes(p.id.toUpperCase()));
}

function envFilesIn(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (isEnvFile(name)) {
        out.push(full);
        continue;
      }
      if (depth >= 2 || SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        /* broken link */
      }
    }
  };
  walk(projectDir, 0);
  return out;
}

export function scanEnvFiles(root: string, providers: Provider[]): { findings: Finding[]; filesScanned: number } {
  const findings: Finding[] = [];
  let filesScanned = 0;
  let projects: string[];
  try {
    projects = readdirSync(root).filter((n) => !n.startsWith(".") && !SKIP_DIRS.has(n));
  } catch {
    return { findings, filesScanned };
  }
  for (const project of projects) {
    const dir = join(root, project);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // Shallowest first, and a plain `.env` before `.env.production`/`.env.backup`: when one
    // project holds two different keys for a provider, the one the vault keeps is the main one.
    const rank = (f: string) => {
      const rel = relative(dir, f).replace(/\\/g, "/");
      return rel.split("/").length * 2 + (rel.endsWith("/.env") || rel === ".env" ? 0 : 1);
    };
    for (const file of envFilesIn(dir).sort((a, b) => rank(a) - rank(b))) {
      filesScanned++;
      let vars: Record<string, string>;
      try {
        vars = parseEnv(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      for (const [envVar, value] of Object.entries(vars)) {
        if (!looksReal(value)) continue;
        const provider = classify(providers, envVar, value);
        if (!provider) continue;
        findings.push({
          project,
          file: relative(dir, file).replace(/\\/g, "/"),
          envVar,
          providerId: provider.id,
          value,
          fingerprint: fingerprint(value),
        });
      }
    }
  }
  return { findings, filesScanned };
}
