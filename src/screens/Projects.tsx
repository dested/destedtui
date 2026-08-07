import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import { T } from "../theme.ts";
import { Footer, type Hint } from "../components/Footer.tsx";
import { CARD_HEIGHT, CARD_MIN_WIDTH, CLAUDE_COMMAND, ProjectCard } from "../components/ProjectCard.tsx";
import { CommandCard } from "../components/CommandCard.tsx";
import { ActionCard, type ActionSpec } from "../components/ActionCard.tsx";
import { CommandDelete, CommandEditor, type CommandDraft } from "../components/CommandEditor.tsx";
import { fuzzyMatch, type Match } from "../lib/fuzzy.ts";
import {
  loadCommands,
  matchCommand,
  normalizeName,
  removeCommand,
  saveCommands,
  upsertCommand,
  type CommandShortcut,
} from "../lib/commands.ts";
import {
  inspectProject,
  matchProject,
  parseQuery,
  scanProjects,
  sortProjects,
  type ProjectDetail,
  type ProjectInfo,
  type SortMode,
} from "../lib/projects.ts";

interface Props {
  root: string;
  /** Where the calling shell is standing — commands run there, unchanged. */
  cwd: string;
  /** Records the open, hands the path (+ optional command) to the shell, and quits. */
  choose: (dir: string, command?: string) => void;
  /** Runs a command in the shell's current directory and quits. */
  run: (command: string) => void;
  /** Opens the startup dashboard (typed "startup" or clicked its card). */
  openStartup: () => void;
  /** Opens the terminal multiplexer (typed "term" or clicked its card). */
  openTerm: () => void;
  /** esc: pop back to the menu, or quit when this screen IS the app. */
  leave: () => void;
}

/** Built-in tui actions the filter can surface (they open a screen, not a dir). */
const ACTIONS: ActionSpec[] = [
  {
    id: "startup",
    title: "startup",
    subtitle: "boot all your dev servers — live console dashboard",
    icon: "⧉",
    keywords: ["boot", "servers", "dev", "dashboard", "run"],
  },
  {
    id: "term",
    title: "term",
    subtitle: "terminal multiplexer — shells & claude sessions in panes",
    icon: "▓",
    keywords: ["terminal", "terminals", "shell", "claude", "tmux", "multiplexer"],
  },
];

/** Same shape as matchCommand: an exactly-typed action name wins outright. */
function matchAction(action: ActionSpec, q: string): Match | null {
  if (!q) return null; // only surface actions once you're typing
  const name = fuzzyMatch(action.title, q);
  const nameScore = name ? name.score + (action.title === q ? 4000 : action.title.startsWith(q) ? 400 : 0) : 0;
  let kwScore = 0;
  for (const kw of action.keywords) {
    const m = fuzzyMatch(kw, q);
    if (m) kwScore = Math.max(kwScore, m.score * 0.6);
  }
  if (nameScore <= 0 && kwScore <= 0) return null;
  return nameScore >= kwScore ? { score: nameScore, positions: name?.positions ?? [] } : { score: kwScore, positions: [] };
}

const SORT_LABELS: Record<SortMode, string> = {
  frecency: "most used",
  modified: "last touched",
  name: "name",
};

const SORT_ORDER: SortMode[] = ["frecency", "modified", "name"];

const GAP = 1;

/**
 * One cell of the grid. Commands and projects share the grid (and therefore the
 * caret, the arrow keys and the mouse) so there is only ever one thing to drive.
 */
type Cell =
  | { kind: "project"; key: string; project: ProjectInfo; positions: number[] }
  | { kind: "command"; key: string; shortcut: CommandShortcut; positions: number[] }
  | { kind: "action"; key: string; action: ActionSpec; positions: number[] };

export function Projects({ root, cwd, choose, run, openStartup, openTerm, leave }: Props) {
  // Scanned during the first render, not in an effect: painting an empty grid
  // and filling it a frame later leaves torn cards behind, and 220 folders cost
  // ~50ms — far below anything you can see.
  const [projects] = useState<ProjectInfo[]>(() => scanProjects(root));
  const [commands, setCommands] = useState<CommandShortcut[]>(() => loadCommands());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortMode>("frecency");
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState(0); // first visible grid row
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [deleting, setDeleting] = useState<CommandShortcut | null>(null);
  const inspectSeq = useRef(0);
  const { width, height } = useTerminalDimensions();

  const parsed = useMemo(() => parseQuery(filter, root), [filter, root]);
  const q = parsed.query.trim().toLowerCase();
  const visible = useMemo<Cell[]>(() => {
    // Built-in actions pin to the very top (they only appear once you type):
    // "startup" should be one keystroke away, never buried under projects.
    const acts: { cell: Cell; s: number }[] = [];
    for (const action of ACTIONS) {
      const m = matchAction(action, q);
      if (m) acts.push({ cell: { kind: "action", key: `act:${action.id}`, action, positions: m.positions }, s: m.score });
    }
    acts.sort((a, b) => b.s - a.s);
    const actionCells = acts.map(({ cell }) => cell);

    // Commands come next: there are a handful of them, they're the fastest thing
    // on the screen, and they'd otherwise drown in 200 projects.
    const matched: { cell: Cell; s: number }[] = [];
    for (const shortcut of commands) {
      const m = matchCommand(shortcut, q);
      if (m) matched.push({ cell: { kind: "command", key: `cmd:${shortcut.name}`, shortcut, positions: m.positions }, s: m.score });
    }
    if (q) matched.sort((a, b) => b.s - a.s);
    const cmds = matched.map(({ cell }) => cell);

    if (!q) {
      const rows = sortProjects(projects, sort).map<Cell>((p) => ({
        kind: "project",
        key: p.dir,
        project: p,
        positions: [],
      }));
      return [...actionCells, ...cmds, ...rows];
    }

    const scored: { cell: Cell; s: number; frecency: number }[] = [];
    for (const p of projects) {
      const m = matchProject(p, q);
      if (!m) continue;
      scored.push({
        cell: { kind: "project", key: p.dir, project: p, positions: m.positions },
        s: m.score,
        frecency: p.score,
      });
    }
    scored.sort((a, b) => b.s - a.s || b.frecency - a.frecency);
    return [...actionCells, ...cmds, ...scored.map(({ cell }) => cell)];
  }, [projects, commands, q, sort]);

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
  const currentProject = current?.kind === "project" ? current.project : null;
  const editing = draft !== null || deleting !== null;

  useEffect(() => {
    if (topRow !== top) setTop(topRow);
  }, [topRow, top]);

  // Live git state for the highlighted project only; stale replies lose.
  useEffect(() => {
    if (!currentProject) {
      setDetail(null);
      return;
    }
    const seq = ++inspectSeq.current;
    setDetail(null);
    const dir = currentProject.dir;
    const t = setTimeout(() => {
      inspectProject(dir).then((d) => {
        if (seq === inspectSeq.current) setDetail(d);
      });
    }, 120);
    return () => clearTimeout(t);
  }, [currentProject?.dir]);

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

  const openAction = (action: ActionSpec) => {
    if (action.id === "startup") openStartup();
    else if (action.id === "term") openTerm();
  };

  const openCell = (cell: Cell) => {
    if (cell.kind === "project") choose(cell.project.dir);
    else if (cell.kind === "command") run(cell.shortcut.command);
    else openAction(cell.action);
  };

  const editCommand = (shortcut: CommandShortcut) =>
    setDraft({ replacing: shortcut.name, name: shortcut.name, command: shortcut.command, field: "name", error: null });

  const commit = (next: CommandShortcut[]) => {
    setCommands(next);
    saveCommands(next);
  };

  const saveDraft = (d: CommandDraft) => {
    const name = normalizeName(d.name);
    if (!name) return setDraft({ ...d, field: "name", error: "a name is required" });
    if (!d.command.trim()) return setDraft({ ...d, field: "command", error: "a command is required" });
    commit(upsertCommand(commands, { name, command: d.command }, d.replacing));
    setDraft(null);
    setSelected(0);
  };

  // The editor owns every key while it's open — see CommandEditor's note on why
  // this screen never mounts an <input>.
  const editorKey = (key: KeyEvent) => {
    if (deleting) {
      if (key.name === "return") {
        commit(removeCommand(commands, deleting.name));
        setDeleting(null);
      } else if (key.name === "escape") setDeleting(null);
      return;
    }
    if (!draft) return;
    // Every edit goes through the updater form: opentui can deliver several key
    // events before React re-renders, and a value-form setState would then read
    // the same stale draft for each one and keep only the last character.
    const edit = (next: (value: string) => string) =>
      setDraft((d) => (d ? withField(d, next(fieldValue(d))) : d));

    if (key.ctrl) {
      if (key.name === "u") edit(() => "");
      return;
    }
    switch (key.name) {
      case "escape":
        setDraft(null);
        return;
      case "return":
        saveDraft(draft);
        return;
      case "tab":
      case "up":
      case "down":
        setDraft((d) => (d ? { ...d, field: d.field === "name" ? "command" : "name", error: null } : d));
        return;
      case "backspace":
        edit((v) => v.slice(0, -1));
        return;
      case "space":
        edit((v) => `${v} `);
        return;
    }
    if (key.meta || key.option) return;
    const ch = key.sequence;
    if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127) {
      edit((v) => v + ch);
    }
  };

  // This screen owns its own type-ahead instead of mounting an <input>: the
  // grid needs left/right, which a focused input would eat as cursor moves.
  useKeyboard((key) => {
    if (editing) {
      editorKey(key);
      return;
    }
    if (key.ctrl) {
      // Keyboard twins for the card buttons — the mouse must never be required.
      if (key.name === "u") setFilter("");
      else if (key.name === "n") setDraft({ replacing: null, name: "", command: "", field: "name", error: null });
      else if (key.name === "d" && currentProject?.devCommand) choose(currentProject.dir, currentProject.devCommand);
      else if (key.name === "k" && currentProject) choose(currentProject.dir, CLAUDE_COMMAND);
      else if (key.name === "e" && current?.kind === "command") editCommand(current.shortcut);
      else if (key.name === "x" && current?.kind === "command") setDeleting(current.shortcut);
      return;
    }
    switch (key.name) {
      case "escape":
        if (filter) setFilter("");
        else leave();
        return;
      case "return":
        if (current) openCell(current);
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
    if (key.meta || key.option) return;
    const ch = key.sequence;
    if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127) {
      setFilter((f) => f + ch);
      setSelected(0);
    }
  });

  const gridRows: Cell[][] = [];
  for (let i = 0; i < windowItems.length; i += cols) gridRows.push(windowItems.slice(i, i + cols));

  const shown = windowItems.length;
  const hidden = count - firstVisible - shown;
  const total = projects.length + commands.length;

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
            <span fg={T.dim}>{q ? `/${total}` : ""}</span>
            <span fg={T.dim}>{"  ·  "}</span>
            <span fg={T.teal}>{q ? "best match" : SORT_LABELS[sort]}</span>
            {topRow > 0 || hidden > 0 ? (
              <span fg={T.dim}>{`  ·  ${firstVisible + 1}-${firstVisible + shown}`}</span>
            ) : null}
          </text>
        </box>

        {draft ? (
          <CommandEditor draft={draft} width={inner} height={gridHeight} />
        ) : deleting ? (
          <CommandDelete target={deleting} width={inner} height={gridHeight} />
        ) : (
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
                {cards.map((cell, c) => {
                  const i = firstVisible + r * cols + c;
                  return cell.kind === "action" ? (
                    <ActionCard
                      key={cell.key}
                      action={cell.action}
                      width={cardWidth}
                      selected={i === index}
                      positions={cell.positions}
                      onHover={() => setSelected(i)}
                      onOpen={() => openAction(cell.action)}
                    />
                  ) : cell.kind === "command" ? (
                    <CommandCard
                      key={cell.key}
                      shortcut={cell.shortcut}
                      width={cardWidth}
                      selected={i === index}
                      positions={cell.positions}
                      onHover={() => setSelected(i)}
                      onRun={() => run(cell.shortcut.command)}
                      onEdit={() => editCommand(cell.shortcut)}
                      onDelete={() => setDeleting(cell.shortcut)}
                    />
                  ) : (
                    <ProjectCard
                      key={cell.key}
                      project={cell.project}
                      width={cardWidth}
                      selected={i === index}
                      positions={cell.positions}
                      onHover={() => setSelected(i)}
                      onClick={() => choose(cell.project.dir)}
                      onRun={(command) => choose(cell.project.dir, command)}
                    />
                  );
                })}
              </box>
            ))}
          </box>
        )}

        <StatusLine cell={current} detail={detail} cwd={cwd} width={inner} />
      </box>
      <Footer hints={hints(editing, current)} />
    </box>
  );
}

const fieldValue = (d: CommandDraft): string => (d.field === "name" ? d.name : d.command);

/** Write the focused field back. Explicit rather than a computed key, for types. */
const withField = (d: CommandDraft, value: string): CommandDraft =>
  d.field === "name" ? { ...d, name: value, error: null } : { ...d, command: value, error: null };

function hints(editing: boolean, current: Cell | null): Hint[] {
  if (editing) {
    return [
      ["tab", "field"],
      ["enter", "save"],
      ["ctrl+u", "clear"],
      ["esc", "cancel"],
    ];
  }
  const actions: Hint[] =
    current?.kind === "action"
      ? [["enter", "open"]]
      : current?.kind === "command"
      ? [
          ["enter", "run"],
          ["ctrl+e", "edit"],
          ["ctrl+x", "delete"],
        ]
      : [
          ["enter", "cd"],
          ["ctrl+d", "dev"],
          ["ctrl+k", "claude"],
        ];
  return [["click", "go"], ["type", "filter"], ["↑↓←→", "move"], ...actions, ["ctrl+n", "new cmd"], ["tab", "sort"], ["esc", "cancel"]];
}

/** One dim line about whatever is under the caret: live git, or what will run. */
function StatusLine({
  cell,
  detail,
  cwd,
  width,
}: {
  cell: Cell | null;
  detail: ProjectDetail | null;
  cwd: string;
  width: number;
}) {
  return (
    <box style={{ height: 1, width, marginTop: 1, flexDirection: "row" }}>
      {!cell ? null : cell.kind === "action" ? (
        <text>
          <span fg={T.orange}>{cell.action.title}</span>
          <span fg={T.dim}>{`  ·  ${cell.action.subtitle}`}</span>
        </text>
      ) : cell.kind === "command" ? (
        <text>
          <span fg={T.fg}>{cell.shortcut.command}</span>
          <span fg={T.dim}>{`  ·  in ${cwd}`}</span>
        </text>
      ) : (
        <text>
          <span fg={T.fg}>{cell.project.dir}</span>
          {!cell.project.isGit ? null : detail === null ? (
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
