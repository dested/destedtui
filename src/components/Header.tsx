import { T } from "../theme.ts";

/** Split a path into its parent (with trailing separator) and leaf folder name. */
function splitPath(p: string): { parent: string; leaf: string } {
  const trimmed = p.replace(/[\\/]+$/, "");
  const m = trimmed.match(/^(.*[\\/])([^\\/]+)$/);
  if (!m) return { parent: "", leaf: trimmed };
  return { parent: m[1] ?? "", leaf: m[2] ?? "" };
}

export function Header({ subtitle }: { subtitle: string }) {
  const { parent, leaf } = splitPath(subtitle);
  return (
    <box
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "space-between",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        backgroundColor: T.bg,
      }}
    >
      <box style={{ flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
        <ascii-font text="DESTED" font="tiny" color={[T.purple, T.blue, T.cyan]} />
        <text fg={T.blue}>tui</text>
      </box>
      {/* The folder you're in is the whole point on the term screen — make it loud:
          bright accent leaf + a folder glyph, the parent path stays dim. */}
      <text>
        <span fg={T.teal}>{"⌂ "}</span>
        <span fg={T.dim}>{parent}</span>
        <b fg={T.teal}>{leaf}</b>
      </text>
    </box>
  );
}
