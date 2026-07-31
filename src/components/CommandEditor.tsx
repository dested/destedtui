import { T } from "../theme.ts";
import type { CommandShortcut } from "../lib/commands.ts";
import { pad } from "../lib/text.ts";

export interface CommandDraft {
  /** The name being replaced when editing an existing shortcut; null when adding. */
  replacing: string | null;
  name: string;
  command: string;
  field: "name" | "command";
  error: string | null;
}

const LABEL = 9;

/**
 * The add/edit form. Deliberately NOT an `<input>`: this screen already captures
 * every keystroke itself (the grid needs ←/→, which a focused input eats), and
 * one owner per screen is also what keeps `enter` from firing twice.
 *
 * It replaces the grid rather than floating over it — an overlay would leave the
 * cards it covered painted underneath.
 */
export function CommandEditor({ draft, width, height }: { draft: CommandDraft; width: number; height: number }) {
  const box = Math.min(width, 64);
  const field = box - 4 - LABEL;

  const row = (label: string, value: string, active: boolean) => (
    <text>
      <span fg={T.dim}>{pad(label, LABEL)}</span>
      <span fg={active ? T.fg : T.dim}>{pad(value, Math.max(1, field - 1))}</span>
      <span fg={active ? T.teal : T.panel}>▏</span>
    </text>
  );

  return (
    <box style={{ height, width, marginTop: 1, backgroundColor: T.panel, flexDirection: "column" }}>
      <box
        title={draft.replacing ? " edit command " : " new command "}
        style={{
          width: box,
          height: 7,
          border: true,
          borderStyle: "rounded",
          borderColor: T.purple,
          titleColor: T.purple,
          padding: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        {row("name", draft.name, draft.field === "name")}
        {row("command", draft.command, draft.field === "command")}
        <text>
          {draft.error ? (
            <span fg={T.red}>{pad(`⚠ ${draft.error}`, box - 4)}</span>
          ) : (
            <span fg={T.dim}>{pad(`type ${draft.name || "a name"} in the filter to find it again`, box - 4)}</span>
          )}
        </text>
      </box>
    </box>
  );
}

/** Type-nothing confirm: a shortcut is one line of config, not a database. */
export function CommandDelete({
  target,
  width,
  height,
}: {
  target: CommandShortcut;
  width: number;
  height: number;
}) {
  const box = Math.min(width, 64);
  return (
    <box style={{ height, width, marginTop: 1, backgroundColor: T.panel, flexDirection: "column" }}>
      <box
        title=" delete command "
        style={{
          width: box,
          // border 2 + padding 2 + the two lines below; one short and the
          // warning line gets clipped away entirely.
          height: 6,
          border: true,
          borderStyle: "rounded",
          borderColor: T.red,
          titleColor: T.red,
          padding: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        <text>
          <span fg={T.red}>{"⚠ "}</span>
          <span fg={T.fg}>{pad(`${target.name} — ${target.command}`, box - 6)}</span>
        </text>
        <text fg={T.dim}>{pad("enter deletes it · esc keeps it", box - 4)}</text>
      </box>
    </box>
  );
}
