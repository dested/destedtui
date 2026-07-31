import { T } from "../theme.ts";
import { fmtAgo, type ProjectInfo } from "../lib/projects.ts";
import { pad } from "../lib/text.ts";
import { Highlighted } from "./Highlight.tsx";

export const CARD_HEIGHT = 6;

/** What the claude button runs, in the project, in your shell. */
export const CLAUDE_COMMAND = "claude --dangerously-skip-permissions";
/** Never render a card narrower than this — three lines of text need the room. */
export const CARD_MIN_WIDTH = 28;

export const STACK_COLORS: Record<string, string> = {
  next: T.fg,
  react: T.cyan,
  "react native": T.cyan,
  expo: T.cyan,
  vite: T.purple,
  svelte: T.orange,
  astro: T.orange,
  nuxt: T.green,
  nest: T.red,
  electron: T.blue,
  remotion: T.purple,
  opentui: T.teal,
  bun: T.fg,
  node: T.green,
  rust: T.orange,
  go: T.cyan,
  python: T.yellow,
  dotnet: T.purple,
  java: T.red,
  ruby: T.red,
  php: T.blue,
  flutter: T.blue,
  web: T.blue,
};

/** A click target inside a card. Stops propagation so the card doesn't also fire. */
export function Button({
  label,
  color,
  onPress,
}: {
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <box
      style={{
        height: 1,
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: T.surfaceAlt,
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onPress();
      }}
    >
      <text fg={color}>{label}</text>
    </box>
  );
}

interface Props {
  project: ProjectInfo;
  width: number;
  selected: boolean;
  /** Characters of the name the filter matched, for highlighting. */
  positions: number[];
  onHover: () => void;
  onClick: () => void;
  /** Run a command in the project after cd-ing there. */
  onRun: (command: string) => void;
}

export function ProjectCard({ project, width, selected, positions, onHover, onClick, onRun }: Props) {
  const inner = width - 4; // border 2 + padding 2
  const stack = project.stack;
  const stackColor = STACK_COLORS[stack] ?? T.dim;

  // Every line is padded to `inner` so the two colour runs can't shift when the
  // text length changes — a card is a fixed rect and must always fill it.
  const nameWidth = Math.max(1, inner - 2 - (stack ? stack.length + 1 : 0));
  const sub = project.pkgName ? `pkg: ${project.pkgName}` : project.description;
  const age = fmtAgo(project.mtime);
  const opens = project.opens > 0 ? ` · ${project.opens}×` : "";
  const right = `${age}${opens}`;
  const branch = pad(project.branch ? `⎇ ${project.branch}` : "◇ no repo", Math.max(1, inner - right.length - 1));

  return (
    <box
      style={{
        width,
        height: CARD_HEIGHT,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: selected ? T.teal : T.border,
        backgroundColor: selected ? T.selectionBg : T.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      onMouseOver={onHover}
      onMouseDown={onClick}
    >
      <text>
        <span fg={selected ? T.teal : T.dim}>{project.isGit ? "◈ " : "◇ "}</span>
        <Highlighted text={project.name} width={nameWidth} positions={positions} match={T.teal} base={T.fg} />
        {stack ? <span fg={stackColor}>{` ${stack}`}</span> : null}
      </text>
      <text fg={T.dim}>{pad(sub, inner)}</text>
      <text>
        <span fg={project.branch ? T.purple : T.dim}>{branch}</span>
        <span fg={T.dim}>{` ${right}`}</span>
      </text>
      <box style={{ flexDirection: "row", gap: 1, height: 1, width: inner }}>
        {project.devCommand ? (
          <Button label="▶ dev" color={T.green} onPress={() => onRun(project.devCommand!)} />
        ) : null}
        <Button label="✦ claude" color={T.purple} onPress={() => onRun(CLAUDE_COMMAND)} />
      </box>
    </box>
  );
}
