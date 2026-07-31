import { fit } from "../lib/text.ts";

interface Props {
  text: string;
  /** Exact cell width — the result is always this wide (padded with spaces). */
  width: number;
  /** Indices in `text` the filter matched. Anything past the truncation is dropped. */
  positions: number[];
  /** Colour for the matched characters. */
  match: string;
  /** Colour for everything else. */
  base: string;
}

/**
 * One padded line with the characters the filter matched picked out, so a
 * fuzzy hit explains itself: type `frop` and you can see the f and the rop.
 */
export function Highlighted({ text, width, positions, match, base }: Props) {
  const cut = fit(text, width);
  // An ellipsis is our own character, never a match — don't light it up.
  const kept = cut.endsWith("…") ? cut.length - 1 : cut.length;
  const padded = cut + " ".repeat(Math.max(0, width - cut.length));
  const hit = new Set(positions.filter((p) => p < kept));

  const runs: { text: string; on: boolean }[] = [];
  for (let i = 0; i < padded.length; i++) {
    const on = hit.has(i);
    const last = runs[runs.length - 1];
    if (last && last.on === on) last.text += padded[i];
    else runs.push({ text: padded[i]!, on });
  }

  return (
    <>
      {runs.map((run, i) => (
        <span key={`${i}-${run.on}`} fg={run.on ? match : base}>
          {run.text}
        </span>
      ))}
    </>
  );
}
