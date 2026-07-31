/**
 * Cell arithmetic for the card grid. Cards are a fixed rect and a box only
 * paints what it occupies, so every line in one has to be cut and padded to an
 * exact width — see the Painting section of ui.md.
 */

/** Hard-truncate to n cells, marking the cut with an ellipsis. */
export function fit(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** Fit, then pad to exactly n cells so a right-hand column never drifts. */
export function pad(s: string, n: number): string {
  const t = fit(s, n);
  return t + " ".repeat(Math.max(0, n - t.length));
}
