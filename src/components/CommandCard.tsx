import { T } from "../theme.ts";
import type { CommandShortcut } from "../lib/commands.ts";
import { pad } from "../lib/text.ts";
import { Button, CARD_HEIGHT } from "./ProjectCard.tsx";
import { Highlighted } from "./Highlight.tsx";

interface Props {
  shortcut: CommandShortcut;
  width: number;
  selected: boolean;
  /** Characters of the name the filter matched, for highlighting. */
  positions: number[];
  onHover: () => void;
  /** Run it in the shell's current directory and quit. */
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * A saved shortcut, drawn as a card the same size as a project so the grid stays
 * one grid. Purple + `⚡` says "this is a command, not a place" at a glance.
 */
export function CommandCard({ shortcut, width, selected, positions, onHover, onRun, onEdit, onDelete }: Props) {
  const inner = width - 4; // border 2 + padding 2
  const badge = "cmd";
  const nameWidth = Math.max(1, inner - 2 - (badge.length + 1));

  return (
    <box
      style={{
        width,
        height: CARD_HEIGHT,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: selected ? T.purple : T.border,
        backgroundColor: selected ? T.selectionBg : T.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      onMouseOver={onHover}
      onMouseDown={onRun}
    >
      <text>
        {/* Single-cell glyph on purpose: ⚡ is double-width and eats the badge. */}
        <span fg={selected ? T.purple : T.dim}>{"▸ "}</span>
        <Highlighted text={shortcut.name} width={nameWidth} positions={positions} match={T.teal} base={T.fg} />
        <span fg={T.purple}>{` ${badge}`}</span>
      </text>
      <text fg={T.dim}>{pad(shortcut.command, inner)}</text>
      <text fg={T.dim}>{pad("runs where your shell is", inner)}</text>
      <box style={{ flexDirection: "row", gap: 1, height: 1, width: inner }}>
        <Button label="▶ run" color={T.green} onPress={onRun} />
        <Button label="✎ edit" color={T.blue} onPress={onEdit} />
        <Button label="✕" color={T.red} onPress={onDelete} />
      </box>
    </box>
  );
}
