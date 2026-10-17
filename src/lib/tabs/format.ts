import type { SavedTab } from "./store.ts";

// Shared by the `tabs` CLI and the Tabs screen; no UI imports, so the CLI stays light.

function ago(epochMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "2h ago · Oct 16, 21:08" */
export function savedLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const when = new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${ago(t, now)} ago · ${when}`;
}

/** "12 claude · 3 shell · 1 app" */
export function kindCounts(tabs: SavedTab[]): string {
  const n = (k: SavedTab["kind"]) => tabs.filter((t) => t.kind === k).length;
  return `${n("claude")} claude · ${n("shell")} shell · ${n("app")} app`;
}
