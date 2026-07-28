import { T } from "../theme.ts";
import { fmtAgo, type ProjectInfo } from "../lib/projects.ts";

export const CARD_HEIGHT = 5;
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

/** Hard-truncate to n cells — cards are fixed width, so nothing may overflow. */
function fit(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** Pad to exactly n cells so the row's right-hand column never drifts. */
function pad(s: string, n: number): string {
  const t = fit(s, n);
  return t + " ".repeat(Math.max(0, n - t.length));
}

interface Props {
  project: ProjectInfo;
  width: number;
  selected: boolean;
  onHover: () => void;
  onClick: () => void;
}

export function ProjectCard({ project, width, selected, onHover, onClick }: Props) {
  const inner = width - 4; // border 2 + padding 2
  const stack = project.stack;
  const stackColor = STACK_COLORS[stack] ?? T.dim;

  // Every line is padded to `inner` so the two colour runs can't shift when the
  // text length changes — a card is a fixed rect and must always fill it.
  const nameWidth = Math.max(1, inner - 2 - (stack ? stack.length + 1 : 0));
  const name = pad(project.name, nameWidth);
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
        <span fg={T.fg}>{name}</span>
        {stack ? <span fg={stackColor}>{` ${stack}`}</span> : null}
      </text>
      <text fg={T.dim}>{pad(sub, inner)}</text>
      <text>
        <span fg={project.branch ? T.purple : T.dim}>{branch}</span>
        <span fg={T.dim}>{` ${right}`}</span>
      </text>
    </box>
  );
}
