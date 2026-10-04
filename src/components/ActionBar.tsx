import { T } from "../theme.ts";

// The action bar: every toggle and action on a screen as a clickable button (ui.md "Action bar").
// Keys stay as silent aliases; nobody should have to remember a letter.

export type BarItem =
  | { kind: "btn"; label: string; color: string; onPress: () => void }
  | { kind: "seg"; label: string; options: { label: string; active: boolean; onPress: () => void }[] };

const itemWidth = (it: BarItem): number =>
  it.kind === "btn" ? it.label.length + 2 : (it.label ? it.label.length + 1 : 0) + it.options.reduce((n, o) => n + o.label.length + 2, 0);

function BarButton({ it }: { it: BarItem }) {
  if (it.kind === "btn")
    return (
      <box style={{ height: 1, width: it.label.length + 2, backgroundColor: T.surfaceAlt }} onMouseDown={it.onPress}>
        <text fg={it.color}>{` ${it.label} `}</text>
      </box>
    );
  return (
    <box style={{ flexDirection: "row", height: 1, width: itemWidth(it) }}>
      {it.label ? <text fg={T.dim}>{`${it.label} `}</text> : null}
      {it.options.map((o) => (
        <box key={o.label} style={{ height: 1, width: o.label.length + 2, backgroundColor: o.active ? T.selectionBg : T.surfaceAlt }} onMouseDown={o.onPress}>
          <text fg={o.active ? T.cyan : T.dim}>{` ${o.label} `}</text>
        </box>
      ))}
    </box>
  );
}

/** One row of buttons: the view's actions on the left, rescan/back flush right. */
export function ActionBar({ width, items, trailing }: { width: number; items: BarItem[]; trailing: BarItem[] }) {
  const GAP = 2;
  const rightW = Math.max(0, trailing.reduce((n, it) => n + itemWidth(it) + 1, -1));
  // Drop actions from the end rather than overflow on a narrow terminal.
  const shown: BarItem[] = [];
  let used = 0;
  for (const it of items) {
    const w = itemWidth(it) + (shown.length ? GAP : 0);
    if (used + w > width - rightW - GAP) break;
    shown.push(it);
    used += w;
  }
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: T.panel }}>
      {shown.map((it, i) => (
        <box key={`${it.label}${i}`} style={{ flexDirection: "row", height: 1, width: itemWidth(it) + (i ? GAP : 0), paddingLeft: i ? GAP : 0 }}>
          <BarButton it={it} />
        </box>
      ))}
      <box style={{ height: 1, width: Math.max(0, width - used - rightW) }} />
      {trailing.map((it, i) => (
        <box key={`t${it.label}`} style={{ flexDirection: "row", height: 1, width: itemWidth(it) + (i ? 1 : 0), paddingLeft: i ? 1 : 0 }}>
          <BarButton it={it} />
        </box>
      ))}
    </box>
  );
}


export const btn = (label: string, color: string, onPress: () => void): BarItem => ({ kind: "btn", label, color, onPress });
export const seg = <V extends string>(label: string, options: readonly V[], value: V, onChange: (v: V) => void, names?: Partial<Record<V, string>>): BarItem => ({
  kind: "seg",
  label,
  options: options.map((o) => ({ label: names?.[o] ?? o, active: o === value, onPress: () => onChange(o) })),
});
