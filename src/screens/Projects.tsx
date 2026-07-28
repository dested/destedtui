import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { T } from "../theme.ts";
import { Footer } from "../components/Footer.tsx";
import { CARD_HEIGHT, CARD_MIN_WIDTH, ProjectCard } from "../components/ProjectCard.tsx";
import {
  inspectProject,
  parseQuery,
  scanProjects,
  sortProjects,
  type ProjectDetail,
  type ProjectInfo,
  type SortMode,
} from "../lib/projects.ts";

interface Props {
  root: string;
  /** Records the open, hands the path to the shell, and quits. */
  choose: (dir: string) => void;
  /** esc: pop back to the menu, or quit when this screen IS the app. */
  leave: () => void;
}

const SORT_LABELS: Record<SortMode, string> = {
  frecency: "most used",
  modified: "last touched",
  name: "name",
};

const SORT_ORDER: SortMode[] = ["frecency", "modified", "name"];

const GAP = 1;

/** Prefix > word-start > substring > subsequence. */
function score(project: ProjectInfo, q: string): number {
  if (!q) return 1;
  const name = project.name.toLowerCase();
  if (name === q) return 200;
  if (name.startsWith(q)) return 120;
  if (name.split(/[-_. ]/).some((w) => w.startsWith(q))) return 90;
  if (name.includes(q)) return 70;
  if (project.pkgName?.toLowerCase().includes(q)) return 50;
  if (project.stack.includes(q)) return 30;
  let i = 0;
  for (const c of name) if (c === q[i] && ++i === q.length) return 10;
  return 0;
}

export function Projects({ root, choose, leave }: Props) {
  // Scanned during the first render, not in an effect: painting an empty grid
  // and filling it a frame later leaves torn cards behind, and 220 folders cost
  // ~50ms — far below anything you can see.
  const [projects] = useState<ProjectInfo[]>(() => scanProjects(root));
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortMode>("frecency");
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState(0); // first visible grid row
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const inspectSeq = useRef(0);
  const { width, height } = useTerminalDimensions();

  const parsed = useMemo(() => parseQuery(filter, root), [filter, root]);
  const q = parsed.query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return sortProjects(projects, sort);
    const scored = projects.map((p) => ({ p, s: score(p, q) })).filter(({ s }) => s > 0);
    scored.sort((a, b) => b.s - a.s || b.p.score - a.p.score);
    return scored.map(({ p }) => p);
  }, [projects, q, sort]);

  // --- grid geometry (all explicit: nothing may size to its content) --------
  const inner = width - 6; // margin 2 + border 2 + padding 2
  const cols = Math.max(1, Math.floor((inner + GAP) / (CARD_MIN_WIDTH + GAP)));
  const cardWidth = Math.floor((inner - (cols - 1) * GAP) / cols);
  // chrome: header 3, panel top 2, search 2, status 2, panel bottom 2, footer 1
  const gridHeight = Math.max(CARD_HEIGHT, height - 12);
  const visRows = Math.max(1, Math.floor((gridHeight + GAP) / (CARD_HEIGHT + GAP)));

  const count = visible.length;
  const index = Math.min(selected, Math.max(0, count - 1));
  const totalRows = Math.ceil(count / cols);
  const row = Math.floor(index / cols);

  // Keep the caret on screen without ever leaving a gap at the bottom.
  const maxTop = Math.max(0, totalRows - visRows);
  const topRow = Math.min(Math.max(Math.min(top, maxTop), row - visRows + 1), row);
  const firstVisible = topRow * cols;
  const windowItems = visible.slice(firstVisible, firstVisible + visRows * cols);
  const current = visible[index] ?? null;

  useEffect(() => {
    if (topRow !== top) setTop(topRow);
  }, [topRow, top]);

  // Live git state for the highlighted project only; stale replies lose.
  useEffect(() => {
    if (!current) {
      setDetail(null);
      return;
    }
    const seq = ++inspectSeq.current;
    setDetail(null);
    const t = setTimeout(() => {
      inspectProject(current.dir).then((d) => {
        if (seq === inspectSeq.current) setDetail(d);
      });
    }, 120);
    return () => clearTimeout(t);
  }, [current?.dir]);

  const move = (delta: number) => setSelected(() => Math.min(Math.max(0, index + delta), Math.max(0, count - 1)));
  const scroll = (rows: number) => {
    setTop((t) => Math.min(Math.max(0, t + rows), maxTop));
    // keep the selection inside the new window rather than dragging it along
    setSelected((s) => {
      const nextTop = Math.min(Math.max(0, topRow + rows), maxTop);
      const r = Math.floor(Math.min(s, count - 1) / cols);
      if (r < nextTop) return nextTop * cols + (s % cols);
      if (r > nextTop + visRows - 1) return (nextTop + visRows - 1) * cols + (s % cols);
      return s;
    });
  };

  // This screen owns its own type-ahead instead of mounting an <input>: the
  // grid needs left/right, which a focused input would eat as cursor moves.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "u") {
      setFilter("");
      return;
    }
    switch (key.name) {
      case "escape":
        if (filter) setFilter("");
        else leave();
        return;
      case "return":
        if (current) choose(current.dir);
        return;
      case "tab":
        setSort((s) => SORT_ORDER[(SORT_ORDER.indexOf(s) + 1) % SORT_ORDER.length]!);
        return;
      case "backspace":
        setFilter((f) => f.slice(0, -1));
        return;
      case "left":
        move(-1);
        return;
      case "right":
        move(1);
        return;
      case "up":
        move(-cols);
        return;
      case "down":
        move(cols);
        return;
      case "pageup":
        move(-cols * visRows);
        return;
      case "pagedown":
        move(cols * visRows);
        return;
      case "home":
        setSelected(0);
        return;
      case "end":
        setSelected(Math.max(0, count - 1));
        return;
      case "space":
        setFilter((f) => `${f} `);
        return;
    }
    if (key.ctrl || key.meta || key.option) return;
    const ch = key.sequence;
    if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127) {
      setFilter((f) => f + ch);
      setSelected(0);
    }
  });

  const gridRows: ProjectInfo[][] = [];
  for (let i = 0; i < windowItems.length; i += cols) gridRows.push(windowItems.slice(i, i + cols));

  const shown = windowItems.length;
  const hidden = count - firstVisible - shown;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" projects "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: T.border,
          titleColor: T.teal,
          margin: 1,
          marginTop: 0,
          padding: 1,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1, width: inner }}>
          <text>
            <span fg={T.teal}>{"❯ "}</span>
            {parsed.ignored ? <span fg={T.dim}>{parsed.ignored}</span> : null}
            <span fg={T.fg}>{parsed.rest}</span>
            <span fg={T.teal}>▏</span>
            {filter ? null : <span fg={T.dim}>type to filter</span>}
          </text>
          <text>
            <span fg={count === 0 ? T.red : T.green}>{`${count}`}</span>
            <span fg={T.dim}>{q ? `/${projects.length}` : ""}</span>
            <span fg={T.dim}>{"  ·  "}</span>
            <span fg={T.teal}>{q ? "best match" : SORT_LABELS[sort]}</span>
            {topRow > 0 || hidden > 0 ? (
              <span fg={T.dim}>{`  ·  ${firstVisible + 1}-${firstVisible + shown}`}</span>
            ) : null}
          </text>
        </box>

        <box
          style={{
            flexDirection: "column",
            gap: GAP,
            height: gridHeight,
            width: inner,
            marginTop: 1,
            // Fills the whole grid rect every frame, so cards removed by the
            // filter don't leave their borders behind.
            backgroundColor: T.panel,
          }}
          onMouseScroll={(e) => {
            if (e.scroll) scroll(e.scroll.direction === "up" ? -1 : 1);
          }}
        >
          {count === 0 && <text fg={T.dim}>{q ? `Nothing matches "${parsed.query}"` : `No folders in ${root}`}</text>}
          {gridRows.map((cards, r) => (
            <box key={`row-${topRow + r}`} style={{ flexDirection: "row", gap: GAP, height: CARD_HEIGHT }}>
              {cards.map((p, c) => {
                const i = firstVisible + r * cols + c;
                return (
                  <ProjectCard
                    key={p.dir}
                    project={p}
                    width={cardWidth}
                    selected={i === index}
                    onHover={() => setSelected(i)}
                    onClick={() => choose(p.dir)}
                  />
                );
              })}
            </box>
          ))}
        </box>

        <StatusLine project={current} detail={detail} width={inner} />
      </box>
      <Footer
        hints={[
          ["click", "go"],
          ["type", "filter"],
          ["↑↓←→", "move"],
          ["enter", "go"],
          ["tab", "sort"],
          ["esc", "cancel"],
        ]}
      />
    </box>
  );
}

/** One dim line of live git state for whatever is under the caret. */
function StatusLine({
  project,
  detail,
  width,
}: {
  project: ProjectInfo | null;
  detail: ProjectDetail | null;
  width: number;
}) {
  return (
    <box style={{ height: 1, width, marginTop: 1, flexDirection: "row" }}>
      {!project ? null : (
        <text>
          <span fg={T.fg}>{project.dir}</span>
          {!project.isGit ? null : detail === null ? (
            <span fg={T.dim}>{"  ·  reading git..."}</span>
          ) : detail.error ? (
            <span fg={T.red}>{`  ·  ⚠ ${detail.error}`}</span>
          ) : (
            <>
              <span fg={T.dim}>{"  ·  "}</span>
              {detail.ahead > 0 ? <span fg={T.green}>{`↑${detail.ahead} `}</span> : null}
              {detail.behind > 0 ? <span fg={T.orange}>{`↓${detail.behind} `}</span> : null}
              {detail.dirty > 0 ? (
                <span fg={T.yellow}>{`● ${detail.dirty} changed`}</span>
              ) : (
                <span fg={T.green}>✓ clean</span>
              )}
              {detail.lastCommit ? (
                <span fg={T.dim}>{`  ·  ${detail.lastCommit.hash} ${detail.lastCommit.when} — ${detail.lastCommit.subject.slice(0, 56)}`}</span>
              ) : null}
            </>
          )}
        </text>
      )}
    </box>
  );
}
