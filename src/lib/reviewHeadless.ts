import { buildPrompt, scopeLabel, startReview } from "./review.ts";
import type { ReviewResult, ReviewScope, Severity, Verdict } from "./review.ts";

const ESC = String.fromCharCode(0x1b);
const useColor = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

function paint(code: string, text: string): string {
  return useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

export const red = (t: string): string => paint("31;1", t);
export const yellow = (t: string): string => paint("33", t);
export const green = (t: string): string => paint("32;1", t);
export const dim = (t: string): string => paint("2", t);
export const bold = (t: string): string => paint("1", t);

function severityLabel(severity: Severity): string {
  switch (severity) {
    case "blocker":
      return red("BLOCKER");
    case "warn":
      return yellow("WARN   ");
    case "nit":
      return dim("NIT    ");
  }
}

function location(file: string, line: number | null): string {
  return line === null ? file : `${file}:${line}`;
}

export function renderReport(args: {
  result: ReviewResult;
  verdict: Verdict;
  scope: ReviewScope;
  costUsd: number | null;
  durationMs: number | null;
}): string {
  const { result, verdict } = args;
  const lines: string[] = [];

  lines.push("");
  lines.push(bold(`── review ── ${scopeLabel(args.scope)} ──`));
  lines.push("");
  lines.push(result.summary.trim());
  lines.push("");

  if (result.findings.length === 0) {
    lines.push(green("No findings."));
  } else {
    for (const finding of result.findings) {
      lines.push(`${severityLabel(finding.severity)} ${bold(location(finding.file, finding.line))} — ${finding.title}`);
      lines.push(`        ${finding.detail.trim().split("\n").join("\n        ")}`);
      if (finding.fix !== null && finding.fix.trim().length > 0) {
        lines.push(dim(`        fix: ${finding.fix.trim()}`));
      }
      lines.push("");
    }
  }

  if (result.notes.length > 0) {
    lines.push(bold("merge & deploy notes:"));
    for (const note of result.notes) lines.push(`  ▪ ${note}`);
    lines.push("");
  }

  const blockers = result.findings.filter((f) => f.severity === "blocker").length;
  const warns = result.findings.filter((f) => f.severity === "warn").length;
  lines.push(
    verdict === "blocked"
      ? red(`verdict: BLOCKED — ${blockers} blocker${blockers === 1 ? "" : "s"}, ${warns} warn${warns === 1 ? "" : "s"}`)
      : green(`verdict: PASS${warns > 0 ? ` — ${warns} warn${warns === 1 ? "" : "s"} worth a look` : ""}`),
  );
  lines.push(dim(`suggested commit: ${result.commitMessage.title}`));

  const meta: string[] = [];
  if (args.costUsd !== null) meta.push(`$${args.costUsd.toFixed(2)}`);
  if (args.durationMs !== null) meta.push(`${Math.round(args.durationMs / 1000)}s`);
  if (meta.length > 0) lines.push(dim(meta.join(" · ")));
  lines.push("");

  return lines.join("\n");
}

export interface HeadlessArgs {
  scope: ReviewScope;
  model: string;
  effort: string;
  dryRun: boolean;
}

export async function runHeadless(root: string, args: HeadlessArgs): Promise<number> {
  if (args.dryRun) {
    console.log(await buildPrompt(args.scope));
    return 0;
  }

  console.log(bold(`review · ${args.model} · effort ${args.effort}`));
  console.log(dim(`reviewing ${scopeLabel(args.scope)} in ${root} — this usually takes a few minutes`));

  const job = startReview(root, args.scope, { model: args.model, effort: args.effort }, (e) => {
    console.log(dim(`  · ${e.tool}${e.arg.length > 0 ? ` ${e.arg}` : ""}`));
  });

  try {
    const outcome = await job.outcome;
    console.log(
      renderReport({
        result: outcome.result,
        verdict: outcome.verdict,
        scope: args.scope,
        costUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
      }),
    );
    return outcome.verdict === "blocked" ? 1 : 0;
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 2;
  }
}
