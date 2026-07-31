/**
 * fzf-style fuzzy matching: a query matches if its characters appear in order,
 * and the score rewards matches that land where a human would break the word.
 * That is what makes `frop` find `frozen-ropes` and `sps` find `salsPowerShellSetup`.
 *
 * Matching is case-insensitive; the bonuses are computed from the ORIGINAL text,
 * because case is exactly what tells us where a camelCase hump starts.
 */

/** Every matched character is worth this much before bonuses. */
const MATCH = 16;
/** First character of the string — the strongest signal there is. */
const HEAD = 18;
/** First character after a separator (`-`, `_`, `.`, space, slash). */
const BOUNDARY = 12;
/** A camelCase hump, or the first digit of a run. */
const CAMEL = 10;
/** Matched immediately after the previous match — keeps runs together. */
const CONSECUTIVE = 8;
/** Per character, when every match landed on a word start (`sps` → `sals-powershell-setup`). */
const ACRONYM = 10;
/** Opening a gap costs more than widening one, so matches stay clustered. */
const GAP_START = -3;
const GAP_EXTEND = -1;

const NEG = -1e9;
const SEPARATOR = /[-_. /\\@:]/;

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** How good a landing spot index `i` is, ignoring what came before in the query. */
function bonusAt(text: string, i: number): number {
  const cur = text[i]!;
  if (i === 0) return HEAD;
  const prev = text[i - 1]!;
  if (SEPARATOR.test(prev)) return BOUNDARY;
  if (isLower(prev) && isUpper(cur)) return CAMEL;
  if (!isDigit(prev) && isDigit(cur)) return CAMEL;
  if (!isLower(prev) && !isUpper(prev) && !isDigit(prev)) return BOUNDARY;
  return 0;
}

/** How well something matched, and which characters to pick out when drawing it. */
export interface Match {
  score: number;
  /** Indices into the original text that were matched — for highlighting. */
  positions: number[];
}

/**
 * Score `query` against `text`, or null when the characters aren't there in
 * order. An empty query matches everything with score 0.
 *
 * Two tables, fzf's V2 recurrence: `D[j][i]` is the best score for a match that
 * ENDS at text[i], `H[j][i]` the best score using text[0..i] at all. The split
 * is what lets us both charge for gaps and walk the answer back out for
 * highlighting.
 */
export function fuzzyMatch(text: string, query: string): Match | null {
  const n = text.length;
  const m = query.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n) return null;

  const hay = text.toLowerCase();
  const needle = query.toLowerCase();

  // Cheap subsequence reject first — most of the list dies here, and it keeps
  // the O(n·m) tables off the hot path for 200-odd projects on every keystroke.
  let q = 0;
  for (let i = 0; i < n && q < m; i++) if (hay[i] === needle[q]) q++;
  if (q < m) return null;

  const bonus: number[] = new Array(n);
  for (let i = 0; i < n; i++) bonus[i] = bonusAt(text, i);

  const D: number[][] = [];
  const H: number[][] = [];
  for (let j = 0; j < m; j++) {
    const dRow: number[] = new Array(n).fill(NEG);
    const hRow: number[] = new Array(n).fill(NEG);
    const dPrev = j > 0 ? D[j - 1]! : null;
    const hPrev = j > 0 ? H[j - 1]! : null;

    for (let i = 0; i < n; i++) {
      if (hay[i] === needle[j]) {
        // Score of everything before this match. Row -1 is a free zero: the
        // text before the first matched char costs nothing, so `rop` scores the
        // same in `ropes` and `frozen-ropes` apart from the landing bonus.
        const before = hPrev === null ? 0 : i > 0 ? hPrev[i - 1]! : NEG;
        if (before > NEG / 2) {
          const consecutive = dPrev !== null && i > 0 && dPrev[i - 1]! > NEG / 2;
          const b = consecutive ? Math.max(bonus[i]!, CONSECUTIVE) : bonus[i]!;
          dRow[i] = before + MATCH + b;
        }
      }
      const skipped = i > 0 ? hRow[i - 1]! + (dRow[i - 1]! > NEG / 2 ? GAP_START : GAP_EXTEND) : NEG;
      hRow[i] = Math.max(dRow[i]!, skipped);
    }
    D.push(dRow);
    H.push(hRow);
  }

  // Best score is where the LAST query character lands, not the end of the
  // string: trailing text is free. Otherwise a long name would lose to a short
  // one on gap penalties alone, and this list ranks by frecency, not length.
  const lastRow = D[m - 1]!;
  let best = NEG;
  let bestAt = -1;
  for (let i = 0; i < n; i++) {
    if (lastRow[i]! > best) {
      best = lastRow[i]!;
      bestAt = i;
    }
  }
  if (bestAt < 0 || best <= NEG / 2) return null;

  // Walk back: at each cell H either took the match (D) or skipped a character.
  const positions: number[] = [];
  let j = m - 1;
  let i = bestAt;
  while (j >= 0 && i >= 0) {
    if (D[j]![i]! > NEG / 2 && D[j]![i]! === H[j]![i]!) {
      positions.push(i);
      j--;
      i--;
    } else {
      i--;
    }
  }
  positions.reverse();

  // Initials: every character landed on a word start or a camelCase hump, so
  // this is an acronym rather than letters scattered through the string. Gap
  // penalties would otherwise sink `sps` in `sals-powershell-setup` below `sps`
  // in `slopshow`, which is backwards.
  const acronym = positions.every((p) => bonus[p]! >= CAMEL);

  return { score: acronym ? best + ACRONYM * m : best, positions };
}

/** Collapse matched indices into `[start, endExclusive)` runs for rendering. */
export function toRanges(positions: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const p of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  return ranges;
}
