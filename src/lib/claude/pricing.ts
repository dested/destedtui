/**
 * Anthropic list prices, $ per million tokens. Claude Code bills a Max plan by
 * subscription, so everything computed from these is "what the API would have
 * charged" — the screen labels it API-equiv.
 *
 * Cache writes: 1.25× input for the 5-minute TTL, 2× for the 1-hour TTL. Cache
 * reads vary by model (0.1× on most, 0.05× Opus 5.5, 0.025× Fable 5.1), so
 * they're listed per model rather than derived. Fast mode is 2× on both sides
 * (Opus 5 / 5.5 published; Opus 4.8 assumed the same).
 *
 * Costs are computed at view time, never cached — fixing a price here reprices
 * all history without a rescan.
 */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

const FAST_MULTIPLIER = 2;
const WRITE_5M = 1.25;
const WRITE_1H = 2;

/** Longest prefix wins, so `claude-opus-4-5` matches before `claude-opus-4`. */
const TABLE: [prefix: string, rates: Rates][] = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-mythos-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5 }],
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5 }],
  ["claude-3-opus", { input: 15, output: 75, cacheRead: 1.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-3-7-sonnet", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-3-5-sonnet", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08 }],
  ["claude-3-haiku", { input: 0.25, output: 1.25, cacheRead: 0.03 }],
];
TABLE.sort((a, b) => b[0].length - a[0].length);

/** Bare aliases Claude Code sometimes records (`opus`, `opus[1m]`). */
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
};

export interface Priced {
  rates: Rates | null;
  /** The model wasn't in the table and was priced by family, or not at all. */
  estimated: boolean;
}

const memo = new Map<string, Priced>();

export function ratesFor(model: string): Priced {
  const hit = memo.get(model);
  if (hit) return hit;
  const bare = model.replace(/\[.*\]$/, "");
  const id = ALIASES[bare] ?? bare;
  let out: Priced = { rates: null, estimated: true };
  if (model === "<synthetic>") out = { rates: { input: 0, output: 0, cacheRead: 0 }, estimated: false };
  else {
    const exact = TABLE.find(([p]) => id.startsWith(p));
    if (exact) out = { rates: exact[1], estimated: id !== bare };
    else {
      // An unreleased id: price it like the newest of its family, flagged.
      const fam = ["fable", "mythos", "opus", "sonnet", "haiku"].find((f) => id.includes(f));
      const fallback = fam ? ALIASES[fam === "mythos" ? "fable" : fam] : undefined;
      const rates = fallback ? TABLE.find(([p]) => fallback.startsWith(p))?.[1] : undefined;
      out = { rates: rates ?? null, estimated: true };
    }
  }
  memo.set(model, out);
  return out;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function costOf(model: string, t: TokenCounts, fast: boolean): number {
  const { rates } = ratesFor(model);
  if (!rates) return 0;
  const m = fast ? FAST_MULTIPLIER : 1;
  return (
    (t.input * rates.input * m +
      t.output * rates.output * m +
      t.cacheRead * rates.cacheRead * m +
      t.cacheWrite5m * rates.input * WRITE_5M * m +
      t.cacheWrite1h * rates.input * WRITE_1H * m) /
    1_000_000
  );
}

/** `claude-opus-5-5` → `opus 5.5`, `claude-haiku-4-5-20251001` → `haiku 4.5`. */
export function shortModel(model: string): string {
  const bare = ALIASES[model.replace(/\[.*\]$/, "")] ?? model;
  // The (?!\d) keeps a date suffix (`-20250514`) from reading as a minor version.
  const m = bare.match(/^claude-(?:(\d)-(\d)-)?([a-z]+)(?:-(\d)(?!\d))?(?:-(\d)(?!\d))?/);
  if (!m) return model;
  const [, a, b, fam, x, y] = m;
  if (a) return `${fam} ${a}.${b}`;
  return `${fam} ${x ?? ""}${y ? `.${y}` : ""}`.trim();
}
