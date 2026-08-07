import { T } from "../theme.ts";
import { pad } from "../lib/text.ts";
import { Button, CARD_HEIGHT } from "./ProjectCard.tsx";
import { Highlighted } from "./Highlight.tsx";

/** A built-in tui action surfaced in the picker (e.g. typing "startup"). */
export interface ActionSpec {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  /** Extra words the filter can match besides the title. */
  keywords: string[];
}

interface Props {
  action: ActionSpec;
  width: number;
  selected: boolean;
  positions: number[];
  onHover: () => void;
  onOpen: () => void;
}

/**
 * A tui action drawn as a card the same size as a project. Orange + `⧉` says
 * "this opens a screen inside the tui", distinct from purple command shortcuts.
 */
export function ActionCard({ action, width, selected, positions, onHover, onOpen }: Props) {
  const inner = width - 4; // border 2 + padding 2
  const badge = "action";
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
        borderColor: selected ? T.orange : T.border,
        backgroundColor: selected ? T.selectionBg : T.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      onMouseOver={onHover}
      onMouseDown={onOpen}
    >
      <text>
        <span fg={selected ? T.orange : T.dim}>{`${action.icon} `}</span>
        <Highlighted text={action.title} width={nameWidth} positions={positions} match={T.teal} base={T.fg} />
        <span fg={T.orange}>{` ${badge}`}</span>
      </text>
      <text fg={T.dim}>{pad(action.subtitle, inner)}</text>
      <text fg={T.dim}>{pad("opens inside the tui", inner)}</text>
      <box style={{ flexDirection: "row", gap: 1, height: 1, width: inner }}>
        <Button label="⧉ open" color={T.orange} onPress={onOpen} />
      </box>
    </box>
  );
}
