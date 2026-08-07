import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { ListPicker, type ListItem } from "../components/ListPicker.tsx";
import { Footer, type Hint } from "../components/Footer.tsx";
import { fit, wrap } from "../lib/text.ts";
import {
  DEFAULT_MODEL,
  scopeLabel,
  startReview,
  type ReviewJob,
  type ReviewOutcome,
  type ReviewScope,
  type ReviewToolEvent,
} from "../lib/review.ts";
import {
  branchAheadCount,
  commit,
  currentBranch,
  hasCommits,
  hasStagedChanges,
  mainBranch,
  openPrs,
  parentOr,
  recentCommits,
  repoRoot,
  stageAll,
  stagedCount,
  uncommittedCount,
  type CommitInfo,
  type PrInfo,
} from "../lib/reviewGit.ts";

interface Props {
  cwd: string;
  scope?: ReviewScope;
  autoStart?: boolean;
  back: () => void;
}

type Phase = "loading" | "pick" | "pickCommits" | "pickPr" | "running" | "done" | "error";

type CommitState =
  | { step: "idle" }
  | { step: "working" }
  | { step: "done"; sha: string }
  | { step: "error"; msg: string };

interface Stats {
  uncommitted: number | null;
  staged: number | null;
  commits: CommitInfo[] | null;
  branch: { base: string | null; current: string; ahead: number } | null;
  /** Outer null = still loading; inner null = gh is missing or unauthed. */
  prs: { list: PrInfo[] | null } | null;
}

const COMMIT_COUNT = 15;
const MAX_EVENTS = 500;
const SUMMARY_ROWS = 6;

/** Every tool the reviewer can call gets one single-cell glyph. */
function toolIcon(tool: string): string {
  if (tool === "Read") return "▸";
  if (tool === "Grep" || tool === "Glob") return "≡";
  if (tool === "Bash") return "»";
  return "·";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Review({ cwd, scope: initialScope, autoStart, back }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [scope, setScope] = useState<ReviewScope | null>(initialScope ?? null);
  const [stats, setStats] = useState<Stats>({ uncommitted: null, staged: null, commits: null, branch: null, prs: null });
  const [events, setEvents] = useState<ReviewToolEvent[]>([]);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [commitState, setCommitState] = useState<CommitState>({ step: "idle" });
  const [errorText, setErrorText] = useState("");
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const rootRef = useRef<string | null>(null);
  const jobRef = useRef<ReviewJob | null>(null);
  const pendingRef = useRef<ReviewToolEvent[]>([]);
  const startedAt = useRef(Date.now());
  const { width } = useTerminalDimensions();

  // panel = margin 1 + border 1 + padding 1 on each side
  const inner = Math.max(20, width - 6);

  const flushPending = () => {
    if (pendingRef.current.length === 0) return;
    const batch = pendingRef.current.splice(0, pendingRef.current.length);
    setEvents((prev) => {
      const next = [...prev, ...batch];
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    });
  };

  const begin = (next: ReviewScope) => {
    const root = rootRef.current;
    if (root === null) return;
    setScope(next);
    setEvents([]);
    setOutcome(null);
    setCommitState({ step: "idle" });
    pendingRef.current = [];
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("running");
    const job = startReview(root, next, {}, (e) => {
      pendingRef.current.push(e);
    });
    jobRef.current = job;
    job.outcome
      .then((o) => {
        // A cancelled/superseded job must not clobber the run that replaced it.
        if (jobRef.current !== job) return;
        flushPending();
        setOutcome(o);
        setPhase("done");
      })
      .catch((err) => {
        if (jobRef.current !== job) return;
        flushPending();
        setErrorText(message(err));
        setPhase("error");
      });
  };

  useEffect(() => {
    let cancelled = false;
    const patch = (f: (s: Stats) => Stats) => {
      if (!cancelled) setStats(f);
    };
    (async () => {
      const root = await repoRoot(cwd);
      if (cancelled) return;
      if (root === null) {
        setErrorText("not inside a git repository");
        setPhase("error");
        return;
      }
      const commits = await hasCommits(root);
      if (cancelled) return;
      if (!commits) {
        setErrorText("repository has no commits yet — make an initial commit first (nothing to diff against)");
        setPhase("error");
        return;
      }
      rootRef.current = root;
      if (autoStart && initialScope) begin(initialScope);
      else setPhase("pick");

      // Every stat feeds one picker row; they land independently so the list is
      // usable the moment the cheapest of them answers.
      uncommittedCount(root)
        .then((n) => patch((s) => ({ ...s, uncommitted: n })))
        .catch(() => patch((s) => ({ ...s, uncommitted: 0 })));
      stagedCount(root)
        .then((n) => patch((s) => ({ ...s, staged: n })))
        .catch(() => patch((s) => ({ ...s, staged: 0 })));
      recentCommits(root, COMMIT_COUNT)
        .then((list) => patch((s) => ({ ...s, commits: list })))
        .catch(() => patch((s) => ({ ...s, commits: [] })));
      (async () => {
        const current = await currentBranch(root);
        const base = await mainBranch(root);
        const ahead = base === null || base === current ? 0 : await branchAheadCount(root, base);
        return { base, current, ahead };
      })()
        .then((branch) => patch((s) => ({ ...s, branch })))
        .catch(() => patch((s) => ({ ...s, branch: { base: null, current: "", ahead: 0 } })));
      openPrs(root)
        .then((list) => patch((s) => ({ ...s, prs: { list } })))
        .catch(() => patch((s) => ({ ...s, prs: { list: null } })));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // The reviewer emits a tool event per file it touches — batch them like
  // ProcessView batches output lines, or React re-renders per keystroke of work.
  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => {
      if (pendingRef.current.length) {
        const batch = pendingRef.current.splice(0, pendingRef.current.length);
        setEvents((prev) => {
          const next = [...prev, ...batch];
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
      }
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 80);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "running" && commitState.step !== "working") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, [phase, commitState.step]);

  useEffect(
    () => () => {
      const job = jobRef.current;
      jobRef.current = null;
      job?.cancel();
    },
    [],
  );

  const doCommit = () => {
    const root = rootRef.current;
    const current = scope;
    if (root === null || outcome === null || current === null) return;
    const { title, body } = outcome.result.commitMessage;
    setCommitState({ step: "working" });
    (async () => {
      try {
        if (current.kind !== "staged") {
          await stageAll(root);
          if (!(await hasStagedChanges(root))) {
            setCommitState({ step: "error", msg: "nothing to commit after staging" });
            return;
          }
        }
        const sha = await commit(root, title, body);
        setCommitState({ step: "done", sha });
      } catch (err) {
        setCommitState({ step: "error", msg: message(err) });
      }
    })();
  };

  const pick = (id: string) => {
    const branch = stats.branch;
    if (id === "uncommitted") begin({ kind: "uncommitted" });
    else if (id === "staged") begin({ kind: "staged" });
    else if (id === "lastCommit") begin({ kind: "lastCommit" });
    else if (id === "commits") setPhase("pickCommits");
    else if (id === "pr") setPhase("pickPr");
    else if (id === "branch" && branch && branch.base !== null) begin({ kind: "branch", base: branch.base });
  };

  /** Reviewing "from" a commit means that commit plus everything after it. */
  const chooseCommit = (index: number) => {
    const root = rootRef.current;
    const target = (stats.commits ?? [])[index];
    if (root === null || target === undefined) return;
    parentOr(root, target.sha)
      .then((baseSha) =>
        begin({ kind: "commits", fromSha: target.sha, baseSha, count: index + 1, fromTitle: target.title }),
      )
      .catch((err) => {
        setErrorText(message(err));
        setPhase("error");
      });
  };

  const verdict = outcome?.verdict ?? null;
  const canCommit = scope !== null && (scope.kind === "uncommitted" || scope.kind === "staged" || scope.kind === "branch");

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (phase === "pickCommits" || phase === "pickPr") setPhase("pick");
      else if (phase === "running") {
        const job = jobRef.current;
        jobRef.current = null;
        job?.cancel();
        setPhase("pick");
      } else if (phase === "done") {
        setOutcome(null);
        setPhase("pick");
      } else if (phase === "error") {
        if (rootRef.current === null) back();
        else setPhase("pick");
      } else back();
      return;
    }
    // enter belongs to ListPicker — handling it here would fire both.
    if (phase !== "done" || key.ctrl) return;
    if (key.name === "c" && canCommit && verdict === "pass" && commitState.step === "idle") doCommit();
    else if (key.name === "f" && canCommit && verdict === "blocked" && commitState.step === "idle") doCommit();
    else if (key.name === "r" && scope) begin(scope);
  });

  const filesRead = useMemo(() => {
    const seen = new Set<string>();
    for (const e of events) if (e.tool === "Read") seen.add(e.arg);
    return seen.size;
  }, [events]);

  const pickItems = useMemo<ListItem[]>(() => {
    const { uncommitted, staged, commits, branch, prs } = stats;
    const head = commits?.[0] ?? null;
    const branchUsable = branch !== null && branch.base !== null && branch.current !== branch.base;
    return [
      {
        id: "uncommitted",
        icon: "±",
        title: "Uncommitted changes",
        subtitle: "staged + unstaged + untracked vs HEAD",
        badge: uncommitted === null ? "…" : uncommitted > 0 ? `${uncommitted} files` : "clean",
        badgeColor: uncommitted !== null && uncommitted > 0 ? T.green : T.dim,
        disabled: uncommitted === null || uncommitted === 0,
      },
      {
        id: "staged",
        icon: "▣",
        title: "Staged only",
        subtitle: "exactly what's in the index",
        badge: staged === null ? "…" : staged > 0 ? `${staged} files` : "nothing staged",
        badgeColor: staged !== null && staged > 0 ? T.green : T.dim,
        disabled: staged === null || staged === 0,
      },
      {
        id: "lastCommit",
        icon: "◷",
        title: "Last commit",
        subtitle: head ? `${head.shortSha} ${fit(head.title, 48)}` : "",
        badge: commits === null ? "…" : "HEAD",
        badgeColor: commits === null ? T.dim : T.cyan,
        disabled: commits !== null && commits.length === 0,
      },
      {
        id: "commits",
        // ☰ measures two cells here and shoved the badge off its column.
        icon: "≡",
        title: "Recent commits",
        subtitle: "pick a commit — reviews it and everything after",
        badge: commits === null ? "…" : `${commits.length} shown`,
        badgeColor: T.dim,
        disabled: commits !== null && commits.length < 2,
      },
      {
        id: "branch",
        icon: "⎇",
        title: "Branch vs main",
        subtitle:
          branch === null
            ? ""
            : branch.base === null
              ? "no main/master found"
              : branch.current === branch.base
                ? `you're on ${branch.base}`
                : `everything on ${branch.current} since ${branch.base}`,
        badge: branch === null ? "…" : branchUsable ? `${branch.ahead} commits` : "on main",
        badgeColor: branch !== null && branchUsable ? T.green : T.dim,
        disabled: branch === null || !branchUsable || (branch.ahead === 0 && uncommitted === 0),
      },
      {
        id: "pr",
        icon: "⇄",
        title: "Pull request",
        subtitle: "review an open PR via gh",
        badge: prs === null ? "…" : prs.list === null ? "gh unavailable" : `${prs.list.length} open`,
        badgeColor: prs !== null && prs.list !== null && prs.list.length > 0 ? T.green : T.dim,
        disabled: prs === null || prs.list === null || prs.list.length === 0,
      },
    ];
  }, [stats]);

  const hints: Hint[] =
    phase === "loading"
      ? [["esc", "back"]]
      : phase === "pick"
        ? [
            ["↑↓", "select"],
            ["enter", "review"],
            ["esc", "back"],
          ]
        : phase === "pickCommits"
          ? [
              ["↑↓", "select"],
              ["enter", "review from here"],
              ["esc", "back"],
            ]
          : phase === "pickPr"
            ? [
                ["↑↓", "select"],
                ["enter", "review this pr"],
                ["esc", "back"],
              ]
            : phase === "running"
              ? [["esc", "cancel"]]
              : phase === "error"
                ? [["esc", "back"]]
                : canCommit && commitState.step === "idle" && verdict === "pass"
                  ? [
                      ["c", "commit"],
                      ["r", "re-run"],
                      ["esc", "back"],
                    ]
                  : canCommit && commitState.step === "idle" && verdict === "blocked"
                    ? [
                        ["f", "force commit"],
                        ["r", "re-run"],
                        ["esc", "back"],
                      ]
                    : [
                        ["r", "re-run"],
                        ["esc", "back"],
                      ];

  const borderColor =
    phase === "done" ? (verdict === "pass" ? T.green : T.red) : phase === "error" ? T.red : T.border;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" review "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor,
          titleColor: T.pink,
          margin: 1,
          marginTop: 0,
          padding: 1,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        {phase === "loading" && <text fg={T.dim}>reading the repo...</text>}

        {phase === "pick" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>what should get reviewed?</text>
            <ListPicker items={pickItems} vimKeys visible={8} onSelect={(item) => pick(item.id)} />
          </box>
        )}

        {phase === "pickCommits" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>review from which commit through HEAD?</text>
            <ListPicker
              vimKeys
              visible={8}
              emptyText="no commits to pick"
              items={(stats.commits ?? []).map((c, i) => ({
                id: c.sha,
                icon: "▸",
                title: `${c.shortSha} ${fit(c.title, 50)}`,
                subtitle: `${c.age} · ${c.author}`,
                badge: i === 0 ? "HEAD" : `HEAD~${i}`,
                badgeColor: T.cyan,
              }))}
              onSelect={(_item, index) => chooseCommit(index)}
            />
          </box>
        )}

        {phase === "pickPr" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>which pull request?</text>
            <ListPicker
              vimKeys
              visible={8}
              emptyText="no open PRs — gh pr list came back empty"
              items={(stats.prs?.list ?? []).map((pr) => ({
                id: String(pr.number),
                icon: "▸",
                title: `#${pr.number} ${fit(pr.title, 50)}`,
                subtitle: `${pr.branch} · ${pr.author}`,
              }))}
              onSelect={(_item, index) => {
                const pr = (stats.prs?.list ?? [])[index];
                if (pr) begin({ kind: "pr", number: pr.number, title: pr.title });
              }}
            />
          </box>
        )}

        {phase === "running" && scope && (
          <>
            <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }}>
              <text>
                <span fg={T.fg}>{scopeLabel(scope)}</span>
                <span fg={T.dim}>{`  ·  ${DEFAULT_MODEL}`}</span>
              </text>
              <text fg={T.yellow}>{`${SPINNER_FRAMES[frame]} reviewing · ${elapsed}s`}</text>
            </box>
            <box style={{ height: 1 }}>
              <text fg={T.dim}>{`${events.length} tool calls · ${filesRead} files read`}</text>
            </box>
            <scrollbox
              focused
              stickyScroll
              style={{
                flexGrow: 1,
                rootOptions: { backgroundColor: T.bg },
                viewportOptions: { backgroundColor: T.bg },
                contentOptions: { backgroundColor: T.bg },
              }}
            >
              {events.map((e, i) => (
                <text key={i}>
                  <span fg={T.cyan}>{`${toolIcon(e.tool)} ${e.tool}`}</span>
                  <span fg={T.dim}>{e.arg ? `  ${e.arg}` : ""}</span>
                </text>
              ))}
            </scrollbox>
          </>
        )}

        {phase === "done" && outcome && <Report outcome={outcome} width={inner} />}

        {phase === "done" && outcome && (
          <box style={{ height: 1 }}>
            {commitState.step === "done" ? (
              <text fg={T.green}>{`✓ committed ${commitState.sha} — ${fit(outcome.result.commitMessage.title, 80)}`}</text>
            ) : commitState.step === "error" ? (
              <text fg={T.red}>{fit(commitState.msg, inner)}</text>
            ) : commitState.step === "working" ? (
              <text fg={T.yellow}>{`${SPINNER_FRAMES[frame]} committing…`}</text>
            ) : canCommit && verdict === "blocked" ? (
              <text fg={T.red}>⚠ blockers present — f force-commits anyway</text>
            ) : (
              <text fg={T.dim}>{`suggested commit: ${fit(outcome.result.commitMessage.title, 80)}`}</text>
            )}
          </box>
        )}

        {phase === "error" && (
          <box style={{ flexDirection: "column" }}>
            {wrap(fit(errorText, 400), inner).map((line, i) => (
              <text key={i} fg={T.red}>
                {line || " "}
              </text>
            ))}
          </box>
        )}
      </box>
      <Footer hints={hints} />
    </box>
  );
}

/** The finished report: verdict banner, summary, findings list. */
function Report({ outcome, width }: { outcome: ReviewOutcome; width: number }) {
  const { result, verdict, costUsd, durationMs } = outcome;
  const pass = verdict === "pass";
  const blockers = result.findings.filter((f) => f.severity === "blocker").length;
  const warns = result.findings.filter((f) => f.severity === "warn").length;
  const nits = result.findings.filter((f) => f.severity === "nit").length;
  const meta = [
    costUsd === null ? [] : [`$${costUsd.toFixed(2)}`],
    durationMs === null ? [] : [`${Math.round(durationMs / 1000)}s`],
  ].flat();
  const summaryWidth = Math.min(96, width);
  // Fixed row count: a resize re-wraps the summary, and a shrinking box leaves its old rows painted.
  const wrapped = wrap(result.summary.trim(), summaryWidth);
  const summaryRows = Array.from({ length: SUMMARY_ROWS }, (_, i) => {
    const line = wrapped[i] ?? "";
    return i === SUMMARY_ROWS - 1 && wrapped.length > SUMMARY_ROWS ? `${fit(line, summaryWidth - 1)}…` : line;
  });

  return (
    <>
      <box style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 5 }}>
        <ascii-font text={pass ? "PASS" : "BLOCKED"} font="tiny" color={pass ? T.green : T.red} />
        <text>
          <span fg={blockers > 0 ? T.red : T.dim}>{`${blockers} blockers`}</span>
          <span fg={T.dim}>{" · "}</span>
          <span fg={warns > 0 ? T.yellow : T.dim}>{`${warns} warns`}</span>
          <span fg={T.dim}>{" · "}</span>
          <span fg={T.dim}>{`${nits} nits`}</span>
          {meta.length > 0 ? <span fg={T.dim}>{` · ${meta.join(" · ")}`}</span> : null}
        </text>
      </box>

      <box style={{ flexDirection: "column", marginTop: 1, marginBottom: 1, height: SUMMARY_ROWS }}>
        {summaryRows.map((line, i) => (
          <text key={i} fg={T.fg}>
            {line || " "}
          </text>
        ))}
      </box>

      <scrollbox
        focused
        style={{
          flexGrow: 1,
          rootOptions: { backgroundColor: T.bg },
          viewportOptions: { backgroundColor: T.bg },
          contentOptions: { backgroundColor: T.bg },
        }}
      >
        {result.notes.length > 0 && (
          <box style={{ flexDirection: "column" }}>
            <text fg={T.dim}>── merge &amp; deploy notes</text>
            {result.notes.map((note, i) => (
              <box key={i} style={{ flexDirection: "column" }}>
                {wrap(note, Math.max(20, width - 6)).map((line, j) => (
                  <text key={j}>
                    <span fg={T.cyan}>{j === 0 ? "▪ " : "  "}</span>
                    <span fg={T.fg}>{line}</span>
                  </text>
                ))}
              </box>
            ))}
            <text> </text>
          </box>
        )}
        {result.findings.length === 0 ? (
          <text fg={T.green}>✓ no findings — clean</text>
        ) : (
          result.findings.map((f, i) => {
            const sevColor = f.severity === "blocker" ? T.red : f.severity === "warn" ? T.yellow : T.dim;
            return (
              <box key={i} style={{ flexDirection: "column" }}>
                <text>
                  <span fg={sevColor}>{`▌${f.severity.toUpperCase()}`}</span>
                  <span>{" "}</span>
                  <b fg={T.fg}>{f.line === null ? f.file : `${f.file}:${f.line}`}</b>
                  <span fg={T.fg}>{` — ${f.title}`}</span>
                </text>
                {wrap(f.detail.trim(), Math.max(20, width - 6)).map((line, j) => (
                  <text key={j} fg={T.dim}>{`  ${line}`}</text>
                ))}
                {f.fix ? (
                  <text>
                    <span fg={T.cyan}>{"  ↪ fix: "}</span>
                    <span fg={T.dim}>{f.fix}</span>
                  </text>
                ) : null}
                <text> </text>
              </box>
            );
          })
        )}
      </scrollbox>
    </>
  );
}
