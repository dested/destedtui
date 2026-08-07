import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import { T } from "../theme.ts";
import { Footer, type Hint } from "../components/Footer.tsx";
import { Button } from "../components/ProjectCard.tsx";
import { pad } from "../lib/text.ts";
import { TerminalView } from "../components/TerminalView.tsx";
import { term, type TermSession } from "../lib/term.ts";

const RAIL_WIDTH = 34;
const CARD_HEIGHT = 5; // border 2 + 3 inner lines

/** Literal ESC bytes break this repo's edit tools — build the sequences from "\x1b". */
const ESC = "\x1b";

/** Translate an opentui key event into the bytes a PTY expects. */
function keyToBytes(key: KeyEvent): string | null {
  const n = key.name;
  if (key.ctrl && n && n.length === 1 && n >= "a" && n <= "z") {
    return String.fromCharCode(n.charCodeAt(0) - 96); // ctrl+a…z → 0x01…0x1a
  }
  // xterm modifier param: 1 + shift(1) + alt(2) + ctrl(4). ctrl+right → CSI 1;5C,
  // which is what made ctrl+←/→ word-jumps do nothing before (modifiers dropped).
  const mod = (key.shift ? 1 : 0) + (key.option ? 2 : 0) + (key.ctrl ? 4 : 0);
  const csi = (final: string) => (mod ? `${ESC}[1;${mod + 1}${final}` : `${ESC}[${final}`);
  const tilde = (code: string) => (mod ? `${ESC}[${code};${mod + 1}~` : `${ESC}[${code}~`);
  switch (n) {
    case "return":
      return "\r";
    case "backspace":
      return "\x7f";
    case "tab":
      return key.shift ? `${ESC}[Z` : "\t";
    case "escape":
      return ESC;
    case "up":
      return csi("A");
    case "down":
      return csi("B");
    case "right":
      return csi("C");
    case "left":
      return csi("D");
    case "home":
      return csi("H");
    case "end":
      return csi("F");
    case "pageup":
      return tilde("5");
    case "pagedown":
      return tilde("6");
    case "delete":
      return tilde("3");
    case "space":
      return " ";
  }
  const seq = key.sequence;
  return seq && seq.length >= 1 ? seq : null;
}

function fmtAge(startedAt: number): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

interface Props {
  cwd: string;
  back: () => void;
}

export function Term({ cwd, back }: Props) {
  const [, force] = useState(0);
  const rerender = () => force((x) => x + 1);
  const leader = useRef(false);
  // Rename lives in a ref so batched keystrokes (opentui can deliver several
  // before React re-renders) don't drop characters the value-form setState would.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Same inline-editor plumbing edits either the title or the note.
  const [editField, setEditField] = useState<"name" | "note">("name");
  const draft = useRef("");

  // No auto-spawn: opening the workspace used to create a shell for you, which —
  // combined with the one you'd then open yourself — is why it "opened two". You
  // start empty and make the first one; the empty state invites it.

  useEffect(() => term.subscribeGlobal(rerender), []);
  // Tick so the card ages stay live even while nothing else changes.
  useEffect(() => {
    const t = setInterval(rerender, 1000);
    return () => clearInterval(t);
  }, []);

  const sessions = term.list();
  const active = term.active();
  const mode = term.mode;

  const startRename = (id: string) => {
    const s = term.get(id);
    if (!s) return;
    draft.current = s.title;
    setEditField("name");
    setEditingId(id);
  };

  const startNote = (id: string) => {
    const s = term.get(id);
    if (!s) return;
    draft.current = s.note;
    setEditField("note");
    setEditingId(id);
  };

  const selectDelta = (d: number) => {
    const ids = sessions.map((s) => s.id);
    if (!ids.length) return;
    const i = Math.max(0, ids.indexOf(term.activeId ?? ""));
    const next = ids[(i + d + ids.length) % ids.length];
    if (next) term.setActive(next);
  };

  const handleRename = (key: KeyEvent) => {
    if (key.name === "escape") return setEditingId(null);
    if (key.name === "return") {
      if (editingId) {
        if (editField === "note") term.setNote(editingId, draft.current);
        else term.rename(editingId, draft.current);
      }
      return setEditingId(null);
    }
    if (key.ctrl && key.name === "u") {
      draft.current = "";
      return rerender();
    }
    if (key.name === "backspace") {
      draft.current = draft.current.slice(0, -1);
      return rerender();
    }
    if (key.name === "space") {
      draft.current += " ";
      return rerender();
    }
    if (key.meta || key.option || key.ctrl) return;
    const ch = key.sequence;
    if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127) {
      draft.current += ch;
      rerender();
    }
  };

  const runLeader = (key: KeyEvent) => {
    if (key.ctrl && key.name === "b") {
      if (active) term.write(active.id, "\x02"); // literal ctrl+b to the pty
      return;
    }
    if (key.name === "left" || key.name === "up") return selectDelta(-1);
    if (key.name === "right" || key.name === "down") return selectDelta(1);
    switch (key.sequence) {
      case "d":
        return term.setMode("nav");
      case "n":
        return void term.create("shell", cwd);
      case "c":
        return void term.create("claude", cwd);
      case "x":
        if (active) term.close(active.id);
        return;
      case "r":
        if (active) startRename(active.id);
        return;
      case "t":
        if (active) startNote(active.id);
        return;
      case "[":
        return selectDelta(-1);
      case "]":
        return selectDelta(1);
      case "q":
        return back();
    }
  };

  useKeyboard((key) => {
    // Renaming owns the keyboard entirely while it's open.
    if (editingId) return handleRename(key);

    // INPUT: keystrokes belong to the focused terminal, except the ctrl+b leader.
    if (mode === "input" && active) {
      if (leader.current) {
        leader.current = false;
        runLeader(key);
        return;
      }
      if (key.ctrl && key.name === "b") {
        leader.current = true;
        return;
      }
      const bytes = keyToBytes(key);
      if (bytes !== null) term.write(active.id, bytes);
      return;
    }

    // NAV: drive the rail.
    if (key.ctrl && key.name === "c") return back();
    switch (key.name) {
      case "escape":
        return back();
      case "up":
      case "left":
        return selectDelta(-1);
      case "down":
      case "right":
        return selectDelta(1);
      case "return":
        if (active) term.setMode("input");
        return;
    }
    switch (key.sequence) {
      case "q":
        return back();
      case "n":
        return void term.create("shell", cwd);
      case "c":
        return void term.create("claude", cwd);
      case "x":
        if (active) term.close(active.id);
        return;
      case "r":
        if (active) startRename(active.id);
        return;
      case "t":
        if (active) startNote(active.id);
        return;
      case "i":
        if (active) term.setMode("input");
        return;
    }
  });

  const noteEditing = editingId !== null && editField === "note" && active !== null && active.id === editingId;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        <Rail
          sessions={sessions}
          activeId={term.activeId}
          cwd={cwd}
          editingId={editField === "name" ? editingId : null}
          draft={draft}
          onRename={startRename}
        />
        <Pane active={active} mode={mode} noteEditing={noteEditing} noteDraft={draft.current} />
      </box>
      <Footer hints={hints(editingId !== null ? editField : null, mode, sessions.length)} />
    </box>
  );
}

function hints(editing: "name" | "note" | null, mode: string, count: number): Hint[] {
  if (editing) {
    return [
      ["type", editing === "note" ? "the note" : "name it"],
      ["enter", "save"],
      ["ctrl+u", "clear"],
      ["esc", "cancel"],
    ];
  }
  if (mode === "input") {
    return [
      ["type", "→ terminal"],
      ["ctrl+b", "leader"],
      ["ctrl+b d", "nav"],
      ["ctrl+b n/c", "new"],
      ["ctrl+b r/t", "name/note"],
    ];
  }
  return [
    ["↑↓", "switch"],
    ["enter", "focus"],
    ["n/c", "new"],
    ["r", "rename"],
    ["t", "note"],
    ["x", count ? "close" : "—"],
    ["q", "back"],
  ];
}

function Rail({
  sessions,
  activeId,
  cwd,
  editingId,
  draft,
  onRename,
}: {
  sessions: TermSession[];
  activeId: string | null;
  cwd: string;
  editingId: string | null;
  draft: { current: string };
  onRename: (id: string) => void;
}) {
  return (
    <box
      title=" terminals "
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: T.border,
        titleColor: T.teal,
        margin: 1,
        marginRight: 0,
        padding: 1,
        backgroundColor: T.panel,
      }}
    >
      <box style={{ flexDirection: "column", gap: 1, flexGrow: 1 }}>
        {sessions.length === 0 ? (
          <text fg={T.dim}>{pad("no terminals yet", RAIL_WIDTH - 4)}</text>
        ) : (
          sessions.map((s) => (
            <TermCard
              key={s.id}
              session={s}
              active={s.id === activeId}
              editing={editingId === s.id}
              draftText={editingId === s.id ? draft.current : ""}
              onRename={() => onRename(s.id)}
            />
          ))
        )}
      </box>
      <box style={{ flexDirection: "column", gap: 1, marginTop: 1 }}>
        <box style={{ flexDirection: "row", gap: 1, height: 1 }}>
          <Button label="+ shell" color={T.green} onPress={() => term.create("shell", cwd)} />
          <Button label="✦ claude" color={T.purple} onPress={() => term.create("claude", cwd)} />
        </box>
        {sessions.length > 0 ? (
          <box style={{ flexDirection: "row", height: 1 }}>
            <Button label="✕ close all" color={T.red} onPress={() => term.closeAll()} />
          </box>
        ) : null}
      </box>
    </box>
  );
}

function TermCard({
  session,
  active,
  editing,
  draftText,
  onRename,
}: {
  session: TermSession;
  active: boolean;
  editing: boolean;
  draftText: string;
  onRename: () => void;
}) {
  const inner = RAIL_WIDTH - 6; // rail border 2 + rail padding 2 + card padding 2
  const accent = session.kind === "claude" ? T.purple : T.green;
  const running = session.status === "running";
  const border = editing ? T.yellow : active ? T.teal : running ? accent : T.border;
  const dot = running ? "●" : "✗";
  const dotColor = running ? accent : T.red;
  const status = running ? "running" : `exit ${session.exitCode}`;
  const meta = `${session.kind} · ${status} · ${running ? fmtAge(session.startedAt) : "done"}`;
  const nameWidth = Math.max(1, inner - 2);

  return (
    <box
      style={{
        height: CARD_HEIGHT,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: border,
        backgroundColor: active ? T.selectionBg : T.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      onMouseDown={() => {
        term.setActive(session.id);
        term.setMode("input");
      }}
    >
      <text>
        {editing ? (
          <>
            <span fg={T.yellow}>{"✎ "}</span>
            <span fg={T.fg}>{draftText}</span>
            <span fg={T.yellow}>▏</span>
          </>
        ) : (
          <>
            <span fg={dotColor}>{`${dot} `}</span>
            <span fg={active ? T.fg : T.dim}>{pad(session.title, nameWidth)}</span>
          </>
        )}
      </text>
      <text fg={T.dim}>{pad(meta, inner)}</text>
      <box style={{ flexDirection: "row", gap: 1, height: 1, width: inner }}>
        <Button
          label="✎ name"
          color={T.blue}
          onPress={() => {
            term.setActive(session.id);
            onRename();
          }}
        />
        <Button label="✕" color={T.red} onPress={() => term.close(session.id)} />
      </box>
    </box>
  );
}

/** Always-visible one-line scratchpad above the terminal; `t` edits it inline. */
function NoteStrip({ session, editing, draft }: { session: TermSession; editing: boolean; draft: string }) {
  return (
    <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}>
      {editing ? (
        <text>
          <span fg={T.yellow}>{"✎ "}</span>
          <span fg={T.fg}>{draft}</span>
          <span fg={T.yellow}>▏</span>
        </text>
      ) : session.note ? (
        <text>
          <span fg={T.blue}>{"✎ "}</span>
          <span fg={T.dim}>{"note: "}</span>
          <span fg={T.fg}>{session.note}</span>
        </text>
      ) : (
        <text fg={T.dim}>{"✎ press t for a note"}</text>
      )}
    </box>
  );
}

function Pane({
  active,
  mode,
  noteEditing,
  noteDraft,
}: {
  active: TermSession | null;
  mode: string;
  noteEditing: boolean;
  noteDraft: string;
}) {
  const focused = mode === "input" && active !== null;
  const statusColor = !active ? T.dim : active.status === "running" ? (focused ? T.teal : T.dim) : T.red;
  const status = !active
    ? ""
    : active.status !== "running"
      ? `exited (${active.exitCode})`
      : focused
        ? "● INPUT — typing goes here"
        : "○ NAV — click or press enter to type";

  return (
    <box
      title={active ? ` ${active.title} ` : " terminal "}
      style={{
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: focused ? T.teal : T.border,
        titleColor: T.cyan,
        margin: 1,
        backgroundColor: T.panel,
      }}
      onMouseDown={() => {
        if (active) term.setMode("input");
      }}
    >
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text fg={T.dim}>{active ? `${active.kind} · ${active.cwd}` : ""}</text>
        <text fg={statusColor}>{status}</text>
      </box>
      {active ? <NoteStrip session={active} editing={noteEditing} draft={noteDraft} /> : null}
      {active ? (
        <box style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
          <TerminalView key={active.id} session={active} />
        </box>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 1 }}>
          <text fg={T.teal}>▓ terminals</text>
          <text fg={T.dim}>your pwsh, or a claude session — as many as you like</text>
          <box style={{ flexDirection: "row", gap: 2, marginTop: 1 }}>
            <text>
              <span fg={T.green}>n</span>
              <span fg={T.dim}>{" or "}</span>
              <span fg={T.green}>+ shell</span>
            </text>
            <text>
              <span fg={T.purple}>c</span>
              <span fg={T.dim}>{" or "}</span>
              <span fg={T.purple}>✦ claude</span>
            </text>
          </box>
        </box>
      )}
    </box>
  );
}
