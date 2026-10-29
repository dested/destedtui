/**
 * One project's Claude Code spend from the usage cache, off the UI thread
 * (the cache is ~16 MB of JSON). Reads the cache only — the Claude usage
 * screen is what rescans transcripts. Message contract: `usageMsgSchema`.
 */
import { readCache } from "../claude/scan.ts";
import { load, summarize } from "../claude/view.ts";
import type { UsageMsg } from "./usage.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<unknown>) => {
  const name = typeof e.data === "string" ? e.data.toLowerCase() : "";
  const post = (m: UsageMsg) => self.postMessage(m);
  try {
    const cache = readCache();
    if (!cache) return post({ type: "none" });
    const ds = load(cache);
    const pick = (days: 7 | 30) => summarize(ds, days).projects.find((p) => p.name.toLowerCase() === name) ?? null;
    const week = pick(7);
    const month = pick(30);
    const all = summarize(ds, 0).projects.find((p) => p.name.toLowerCase() === name) ?? null;
    post({
      type: "usage",
      week: week?.cost ?? 0,
      month: month?.cost ?? 0,
      all: all?.cost ?? 0,
      sessions30: month?.sessions ?? 0,
      lastTs: all?.lastTs ?? 0,
      series: month?.series ?? [],
    });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
