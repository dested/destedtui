/**
 * `destedtui --usage [--days N|all] [--project name] [--json]` — Claude Code
 * usage without the TUI, for Claude sessions and scripts.
 */
import { pad } from "../text.ts";
import { scan } from "./scan.ts";
import { hm, load, rangeLabel, summarize, tok, totalTokens, usd, when, type RangeDays } from "./view.ts";

function parseRange(v: string | undefined): RangeDays {
  if (v === "all" || v === "0") return 0;
  const n = Number(v);
  return n === 1 || n === 7 || n === 30 || n === 90 ? n : 30;
}

export function runUsageCli(args: string[]): number {
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const range = parseRange(at("--days"));
  const only = at("--project")?.toLowerCase();
  const json = args.includes("--json");

  const started = performance.now();
  const cache = scan((p) => {
    if (!json && p.read > 0) process.stderr.write(`\rscanning transcripts ${p.done}/${p.total} · ${(p.bytes / 1e9).toFixed(1)} GB read`);
  });
  if (!json) process.stderr.write(`\r${" ".repeat(60)}\r`);
  const s = summarize(load(cache), range);
  const projects = only ? s.projects.filter((p) => p.name.toLowerCase() === only) : s.projects;
  const sessions = only ? s.sessions.filter((x) => x.project.toLowerCase() === only) : s.sessions;

  if (json) {
    console.log(
      JSON.stringify(
        {
          range: rangeLabel(range),
          pricing: "API-equivalent list prices",
          total: { ...s.total, totalTokens: totalTokens(s.total.tokens) },
          projects: projects.map(({ series: _series, ...p }) => p),
          sessions: sessions.map((x) => ({ ...x, start: new Date(x.start * 1000).toISOString(), end: new Date(x.end * 1000).toISOString() })),
          days: s.dayRows,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const secs = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `Claude Code · ${rangeLabel(range)} · ${usd(s.total.cost)} API-equiv · ${tok(totalTokens(s.total.tokens))} tokens · ${s.total.sessions} sessions · ${hm(s.total.activeMin)} active · ${s.models}  (${secs}s)\n`,
  );
  console.log(`${pad("project", 26)}${"cost".padStart(11)}${"tokens".padStart(9)}${"sess".padStart(6)}${"days".padStart(6)}${"active".padStart(8)}  ${pad("last", 13)}models`);
  for (const p of projects.slice(0, only ? 1 : 25)) {
    console.log(
      `${pad(p.name, 26)}${usd(p.cost).padStart(11)}${tok(totalTokens(p.tokens)).padStart(9)}${String(p.sessions).padStart(6)}${String(p.activeDays).padStart(6)}${hm(p.activeMin).padStart(8)}  ${pad(when(p.lastTs), 13)}${p.models}`,
    );
  }
  if (only) {
    console.log("");
    for (const x of sessions.slice(0, 30)) {
      console.log(`${pad(when(x.start), 14)}${hm(x.activeMin).padStart(6)}${usd(x.cost).padStart(10)}  ${pad(x.title || x.id, 60)} ${x.id}`);
    }
  } else {
    console.log("");
    for (const d of s.dayRows.slice(0, 14)) {
      const top = d.projects
        .slice(0, 4)
        .map((p) => `${p.name} ${usd(p.cost)}`)
        .join(" · ");
      console.log(`${d.day}${usd(d.cost).padStart(11)}${hm(d.activeMin).padStart(8)}${String(d.sessions).padStart(5)} sess  ${top}`);
    }
  }
  return 0;
}
