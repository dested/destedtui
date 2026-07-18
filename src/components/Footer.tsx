import { T } from "../theme.ts";

export type Hint = [key: string, label: string];

export function Footer({ hints }: { hints: Hint[] }) {
  return (
    <box
      style={{
        flexDirection: "row",
        gap: 3,
        paddingLeft: 2,
        paddingRight: 2,
        height: 1,
        backgroundColor: T.panel,
      }}
    >
      {hints.map(([key, label]) => (
        <text key={`${key}-${label}`}>
          <span fg={T.cyan}>{key}</span>
          <span fg={T.dim}>{` ${label}`}</span>
        </text>
      ))}
    </box>
  );
}
