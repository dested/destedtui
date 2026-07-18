import { T } from "../theme.ts";

export function Header({ subtitle }: { subtitle: string }) {
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
      <text fg={T.dim}>{subtitle}</text>
    </box>
  );
}
