import { T } from "../theme.ts";

export function ProgressBar({ pct, width = 40, color = T.blue }: { pct: number; width?: number; color?: string }) {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * width);
  return (
    <box style={{ flexDirection: "row", gap: 1 }}>
      <box style={{ width, height: 1, backgroundColor: T.surface }}>
        <box style={{ width: filled, height: 1, backgroundColor: color }} />
      </box>
      <text fg={T.dim}>{`${Math.round(clamped * 100)}%`}</text>
    </box>
  );
}
