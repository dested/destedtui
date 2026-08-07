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

/** Word-wrap to width, preserving existing newlines; never returns an empty array. */
export function wrap(s: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  for (const paragraph of s.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      let rest = word;
      // A word wider than the column can't be wrapped — hard-split it.
      while (rest.length > width) {
        if (line.length > 0) {
          out.push(line);
          line = "";
        }
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (rest.length === 0) continue;
      if (line.length === 0) line = rest;
      else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
      else {
        out.push(line);
        line = rest;
      }
    }
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}
