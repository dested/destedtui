// Turn cached provider usage into what Sal reads: one line per OWNER.
//
// An owner is a single project (the key is that project's alone), a SHARED group
// (one value active in several projects — never credited to any one of them),
// an UNMATCHED provider-side key (not in the vault: deleted, ephemeral, made in a
// console), or the ACCOUNT (usage no key is credited with).

import type { Vault } from "../vault.ts";
import { utcDay, utcDayStart, type ProviderUsage, type RemoteKey, type UsageCache } from "./cache.ts";

export interface Money {
  /** Last 24h, estimated from UTC day buckets: today + the overlapping part of yesterday. */
  d24: number;
  today: number;
  /** Sum over the window (`days` days, today included). */
  window: number;
  /** One value per day, oldest first, today last. */
  series: number[];
}

export type OwnerKind = "project" | "shared" | "unmatched" | "account";

export interface KeyLine {
  providerId: string;
  remoteKeyId: string | null;
  name?: string;
  vaultKeyIds: string[];
  matchedBy?: RemoteKey["matchedBy"];
  ownerLabel: string;
  usd: Money | null;
  units: (Money & { unit: string }) | null;
  lastUsedAt?: string;
  allocated: boolean;
  /** Part of today/window came from a week-to-date figure (OpenRouter). */
  weekToDate: boolean;
}

export interface UsageLine {
  key: string;
  kind: OwnerKind;
  label: string;
  projects: string[];
  providers: string[];
  usd: Money | null;
  units: (Money & { unit: string }) | null;
  lastUsedAt?: string;
  allocated: boolean;
  weekToDate: boolean;
  keys: KeyLine[];
}

export interface ProviderStatus {
  id: string;
  name: string;
  status: ProviderUsage["status"];
  scope: ProviderUsage["scope"];
  message?: string;
}

export interface UsageView {
  days: number;
  fetchedAt: string;
  lines: UsageLine[];
  providers: ProviderStatus[];
  total: Money;
}

function zero(days: number): Money {
  return { d24: 0, today: 0, window: 0, series: new Array<number>(days).fill(0) };
}

function addInto(m: Money, o: Money): void {
  m.d24 += o.d24;
  m.today += o.today;
  m.window += o.window;
  o.series.forEach((v, i) => (m.series[i] = (m.series[i] ?? 0) + v));
}

function finish(m: Money, now: number): Money {
  const today = m.series[m.series.length - 1] ?? 0;
  const yesterday = m.series[m.series.length - 2] ?? 0;
  const elapsed = (now - utcDayStart(now, 0)) / 86_400_000;
  return { ...m, today: m.today + today, d24: m.d24 + today + yesterday * (1 - elapsed), window: m.window + m.series.reduce((a, b) => a + b, 0) };
}

/** A stable label for keys the vault doesn't know: ephemeral names collapse to one pattern. */
function unmatchedLabel(providerId: string, name: string | undefined): string {
  if (!name) return `${providerId} · deleted keys (no longer listed)`;
  return `${providerId} · "${name.replace(/[-_]?\d{6,}$/, "-*")}"`;
}

export function buildView(cache: UsageCache, vault: Vault, opts: { days?: number; project?: string; provider?: string; now?: number } = {}): UsageView {
  const now = opts.now ?? Date.now();
  const days = Math.min(opts.days ?? cache.days, cache.days);
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < days; i++) dayIndex.set(utcDay(utcDayStart(now, days - 1 - i)), i);

  const byId = new Map(vault.keys.map((k) => [k.id, k]));
  /** Owner of a set of matched vault key ids: every project where that value is (or, if revoked everywhere, was) live. */
  const ownerOf = (ids: string[]): { kind: OwnerKind; projects: string[] } => {
    const fps = new Set(ids.flatMap((id) => byId.get(id)?.fingerprint ?? []));
    if (fps.size === 0) return { kind: "unmatched", projects: [] };
    const same = vault.keys.filter((k) => fps.has(k.fingerprint));
    const live = same.filter((k) => k.revokedAt === undefined);
    const projects = [...new Set((live.length ? live : same).map((k) => k.project))].sort();
    return { kind: projects.length > 1 ? "shared" : "project", projects };
  };

  const keyLines: KeyLine[] = [];
  for (const p of cache.providers) {
    if (opts.provider && p.providerId !== opts.provider) continue;
    const remote = new Map(p.remoteKeys.map((r) => [r.remoteKeyId, r]));
    const usdBy = new Map<string, Money>();
    const unitsBy = new Map<string, Money>();
    const wtd = new Set<string>();
    const slot = (map: Map<string, Money>, id: string) => {
      const m = map.get(id) ?? zero(days);
      map.set(id, m);
      return m;
    };
    for (const r of p.rows) {
      const i = dayIndex.get(r.day);
      if (i === undefined) continue;
      const id = r.remoteKeyId ?? "";
      if (r.usd !== undefined) {
        const m = slot(usdBy, id);
        m.series[i] = (m.series[i] ?? 0) + r.usd;
      }
      if (r.units !== undefined) {
        const m = slot(unitsBy, id);
        m.series[i] = (m.series[i] ?? 0) + r.units;
      }
    }
    for (const w of p.windows) {
      const m = slot(usdBy, w.remoteKeyId);
      m.today += w.today;
      m.d24 += w.today;
      m.window += w.week;
      wtd.add(w.remoteKeyId);
    }
    for (const id of new Set([...usdBy.keys(), ...unitsBy.keys()])) {
      const r = id ? remote.get(id) : undefined;
      const ids = r?.vaultKeyIds ?? [];
      const owner = id ? ownerOf(ids) : { kind: "account" as const, projects: [] };
      const usd = usdBy.get(id);
      const units = unitsBy.get(id);
      keyLines.push({
        providerId: p.providerId,
        remoteKeyId: id || null,
        name: r?.name,
        vaultKeyIds: ids,
        matchedBy: r?.matchedBy,
        ownerLabel: owner.kind === "account" ? "account" : owner.kind === "unmatched" ? unmatchedLabel(p.providerId, r?.name) : owner.projects.join(", "),
        usd: usd ? finish(usd, now) : null,
        units: units && p.unit ? { ...finish(units, now), unit: p.unit } : null,
        lastUsedAt: r?.lastUsedAt,
        allocated: p.allocated,
        weekToDate: wtd.has(id),
      });
    }
  }

  const lines = new Map<string, UsageLine>();
  for (const k of keyLines) {
    const owner = k.remoteKeyId === null ? { kind: "account" as const, projects: [] } : ownerOf(k.vaultKeyIds);
    const key =
      owner.kind === "project" || owner.kind === "shared"
        ? `${owner.kind}:${owner.projects.join(",")}`
        : owner.kind === "account"
          ? `account:${k.providerId}`
          : `unmatched:${k.ownerLabel}`;
    const label =
      owner.kind === "project"
        ? (owner.projects[0] ?? "?")
        : owner.kind === "shared"
          ? `shared × ${owner.projects.length}: ${owner.projects.join(", ")}`
          : owner.kind === "account"
            ? `${k.providerId} · account (no key)`
            : k.ownerLabel;
    const line = lines.get(key) ?? { key, kind: owner.kind, label, projects: owner.projects, providers: [], usd: null, units: null, allocated: false, weekToDate: false, keys: [] };
    if (!line.providers.includes(k.providerId)) line.providers.push(k.providerId);
    if (k.usd) {
      line.usd ??= zero(days);
      addInto(line.usd, k.usd);
    }
    if (k.units && !k.usd) {
      line.units ??= { ...zero(days), unit: k.units.unit };
      if (line.units.unit === k.units.unit) addInto(line.units, k.units);
    }
    if (k.lastUsedAt && (!line.lastUsedAt || k.lastUsedAt > line.lastUsedAt)) line.lastUsedAt = k.lastUsedAt;
    line.allocated ||= k.allocated && k.usd !== null;
    line.weekToDate ||= k.weekToDate;
    line.keys.push(k);
    lines.set(key, line);
  }

  let out = [...lines.values()];
  if (opts.project) {
    const p = opts.project.toLowerCase();
    out = out.filter((l) => l.projects.some((x) => x.toLowerCase() === p));
  }
  const spend = (l: UsageLine) => l.usd?.d24 ?? -1;
  out.sort(
    (a, b) =>
      spend(b) - spend(a) ||
      (b.usd?.today ?? 0) - (a.usd?.today ?? 0) ||
      (b.usd?.window ?? 0) - (a.usd?.window ?? 0) ||
      (b.units?.window ?? 0) - (a.units?.window ?? 0),
  );

  const total = zero(days);
  for (const l of out) if (l.usd) addInto(total, l.usd);

  const providers: ProviderStatus[] = cache.providers
    .filter((p) => !opts.provider || p.providerId === opts.provider)
    .map((p) => ({ id: p.providerId, name: vault.providers.find((x) => x.id === p.providerId)?.name ?? p.providerId, status: p.status, scope: p.scope, message: p.message }));

  return { days, fetchedAt: cache.fetchedAt, lines: out, providers, total };
}

const BARS = "▁▂▃▄▅▆▇█";

/** 7-day sparkline; empty days are a dim dot so a quiet project still reads as a line. */
export function sparkline(series: number[]): string {
  const max = Math.max(...series, 0);
  return series.map((v) => (v <= 0 || max <= 0 ? "·" : (BARS[Math.min(BARS.length - 1, Math.floor((v / max) * (BARS.length - 1) + 0.5))] ?? "▁"))).join("");
}

export function money(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

export function units(v: number, unit: string): string {
  const n = v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`;
  return `${n} ${unit}`;
}

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
