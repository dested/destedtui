import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { T } from "../theme.ts";

export interface ListItem {
  id: string;
  icon?: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  disabled?: boolean;
}

interface Props {
  items: ListItem[];
  onSelect: (item: ListItem, index: number) => void;
  /** Only handle keys when active (default true) */
  active?: boolean;
  visible?: number;
  emptyText?: string;
  /** Reset selection when this changes (e.g. the filter text) */
  resetKey?: string;
  /** Enable j/k navigation — leave off when a text input is on screen */
  vimKeys?: boolean;
}

export function ListPicker({
  items,
  onSelect,
  active = true,
  visible = 12,
  emptyText = "Nothing here",
  resetKey,
  vimKeys = false,
}: Props) {
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [resetKey]);

  const clamped = Math.min(selected, Math.max(0, items.length - 1));

  useKeyboard((key) => {
    if (!active || items.length === 0) return;
    if (key.name === "up" || (vimKeys && key.name === "k" && !key.ctrl)) {
      setSelected((s) => (s - 1 + items.length) % items.length);
    } else if (key.name === "down" || (vimKeys && key.name === "j" && !key.ctrl)) {
      setSelected((s) => (s + 1) % items.length);
    } else if (key.name === "return") {
      const item = items[clamped];
      if (item && !item.disabled) onSelect(item, clamped);
    }
  });

  if (items.length === 0) {
    return (
      <box style={{ padding: 1 }}>
        <text fg={T.dim}>{emptyText}</text>
      </box>
    );
  }

  const start = Math.max(0, Math.min(clamped - Math.floor(visible / 2), items.length - visible));
  const windowItems = items.slice(start, start + visible);

  return (
    <box style={{ flexDirection: "column" }}>
      {start > 0 && <text fg={T.dim}>{`  ▲ ${start} more`}</text>}
      {windowItems.map((item, i) => {
        const index = start + i;
        const isSelected = index === clamped;
        const fg = item.disabled ? T.dim : isSelected ? T.fg : T.fg;
        return (
          <box
            key={item.id}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              paddingLeft: 1,
              paddingRight: 1,
              backgroundColor: isSelected ? T.selectionBg : undefined,
            }}
            onMouseDown={() => {
              setSelected(index);
              if (!item.disabled) onSelect(item, index);
            }}
          >
            <text>
              <span fg={isSelected ? T.blue : T.dim}>{isSelected ? "❯ " : "  "}</span>
              {item.icon ? <span fg={item.disabled ? T.dim : T.cyan}>{`${item.icon} `}</span> : null}
              <span fg={item.disabled ? T.dim : fg}>{item.title}</span>
              {item.subtitle ? <span fg={T.dim}>{`  ${item.subtitle}`}</span> : null}
            </text>
            {item.badge ? <text fg={item.badgeColor ?? T.dim}>{item.badge}</text> : null}
          </box>
        );
      })}
      {start + visible < items.length && <text fg={T.dim}>{`  ▼ ${items.length - start - visible} more`}</text>}
    </box>
  );
}
