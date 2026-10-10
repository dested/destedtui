// @ts-check
// The paused screen. bin/launch.mjs runs this between TUI children: the TUI
// went a minute idle and exited, and this shows where it was and what it gave
// back. Raw ANSI in Node, so it costs next to nothing while it sits there.
// Exit 0 = resume, 1 = quit.

import { readFileSync } from "node:fs";

// Mirrors src/theme.ts (T) — this file can't import TypeScript.
const T = {
  bg: "#16161e",
  panel: "#1a1b26",
  surfaceAlt: "#292e42",
  border: "#3b4261",
  fg: "#c0caf5",
  dim: "#565f89",
  purple: "#bb9af7",
  green: "#9ece6a",
  red: "#f7768e",
};

/** @typedef {{ label: string; commit: number; pausedAt: number }} Paused */

/** The resume file as written by src/lib/pause.ts — only the fields shown here. @returns {Paused | null} */
function readState(/** @type {string | undefined} */ file) {
  if (!file) return null;
  try {
    /** @type {unknown} */
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const label = "label" in raw && typeof raw.label === "string" ? raw.label : "menu";
    const commit = "commit" in raw && typeof raw.commit === "number" ? raw.commit : 0;
    const pausedAt = "pausedAt" in raw && typeof raw.pausedAt === "number" ? raw.pausedAt : Date.now();
    return { label, commit, pausedAt };
  } catch {
    return null;
  }
}

const state = readState(process.argv[2]);

const CSI = "\x1b[";
/** @param {string} hex */
const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
/** @param {string} hex */
const fg = (hex) => `${CSI}38;2;${rgb(hex)}m`;
/** @param {string} hex */
const bg = (hex) => `${CSI}48;2;${rgb(hex)}m`;
const BOLD = `${CSI}1m`;
const NOBOLD = `${CSI}22m`;
/** @param {number} row @param {number} col */
const at = (row, col) => `${CSI}${row};${col}H`;
/** @param {number} n */
const pad = (n) => " ".repeat(Math.max(0, n));

/** @param {number} bytes */
function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** @param {number} ms */
function ago(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min ago`;
  return `${Math.floor(h / 24)} d ${h % 24} h ago`;
}

/** @param {number} ms */
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** @typedef {{ row: number; col: number; width: number }} Rect */
/** @type {Rect} */
let quitBtn = { row: 0, col: 0, width: 0 };

const RESUME = " ▶ resume ";
const QUIT = " ✕ quit ";

function draw() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const width = Math.min(58, cols - 4);
  const inner = width - 4;
  const freed = state && state.commit > 0 ? `and gave back ${size(state.commit)}.` : "and gave its memory back.";

  /** @type {Array<{ text: string; color: string; bold?: boolean; label?: string } | "buttons" | null>} */
  const lines = [
    { text: "◷ destedtui is paused", color: T.fg, bold: true },
    null,
    { text: "A minute with no input, so it exited", color: T.dim },
    { text: freed, color: T.dim },
    null,
    { label: "was on     ", text: state ? state.label : "menu", color: T.fg },
    { label: "paused     ", text: state ? `${clock(state.pausedAt)} · ${ago(Date.now() - state.pausedAt)}` : "—", color: T.fg },
    null,
    "buttons",
    null,
    { text: "click anywhere or press any key to resume", color: T.dim },
  ];
  const height = lines.length + 4; // border 2 + padding 2
  const row0 = Math.max(1, Math.floor((rows - height) / 2) + 1);
  const col0 = Math.max(1, Math.floor((cols - width) / 2) + 1);
  const edge = bg(T.panel) + fg(T.border) + "│";
  const close = fg(T.border) + "│";
  const title = " paused ";

  // Every row is written whole (border, padded content, border) in one pass.
  let out = `${bg(T.bg)}${CSI}2J`;
  out += at(row0, col0) + bg(T.panel) + fg(T.border) + "╭─" + fg(T.purple) + title + fg(T.border) + "─".repeat(Math.max(0, width - 3 - title.length)) + "╮";
  out += at(row0 + 1, col0) + edge + pad(width - 2) + close;
  lines.forEach((line, i) => {
    const row = row0 + 2 + i;
    let body;
    if (line === "buttons") {
      quitBtn = { row, col: col0 + 2 + RESUME.length + 2, width: QUIT.length };
      body = bg(T.surfaceAlt) + fg(T.green) + RESUME + bg(T.panel) + "  " + bg(T.surfaceAlt) + fg(T.red) + QUIT + bg(T.panel) + pad(inner - RESUME.length - 2 - QUIT.length);
    } else if (line === null) {
      body = pad(inner);
    } else {
      const label = line.label ?? "";
      const text = (label + line.text).slice(0, inner);
      const value = text.slice(label.length);
      body = fg(T.dim) + label + (line.bold ? BOLD : "") + fg(line.color) + value + NOBOLD + pad(inner - text.length);
    }
    out += at(row, col0) + edge + " " + body + " " + close;
  });
  out += at(row0 + height - 2, col0) + edge + pad(width - 2) + close;
  out += at(row0 + height - 1, col0) + bg(T.panel) + fg(T.border) + "╰" + "─".repeat(width - 2) + "╯";
  process.stdout.write(out + `${CSI}0m`);
}

const MOUSE_ON = `${CSI}?1000h${CSI}?1006h`;
const MOUSE_OFF = `${CSI}?1000l${CSI}?1006l`;

/** @param {number} code @returns {never} */
function finish(code) {
  process.stdout.write(`${MOUSE_OFF}${CSI}0m${CSI}2J${CSI}?25h${CSI}?1049l`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

/** @param {Rect} r @param {number} row @param {number} col */
const inside = (r, row, col) => row === r.row && col >= r.col && col < r.col + r.width;

/** @param {Buffer} chunk */
function onInput(chunk) {
  const s = chunk.toString("utf8");
  // SGR mouse: ESC [ < button ; col ; row, then M (press) or m (release).
  const mouse = [...s.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
  if (mouse.length > 0) {
    for (const [, b, c, r, kind] of mouse) {
      if (kind !== "M" || Number(b) >= 64) continue; // releases and the wheel don't count
      finish(inside(quitBtn, Number(r), Number(c)) ? 1 : 0);
    }
    return;
  }
  // Focus in/out reports aren't a person asking for anything.
  if (s === `${CSI}I` || s === `${CSI}O`) return;
  finish(s === "q" || s === "\x03" ? 1 : 0);
}

process.stdout.write(`${CSI}?1049h${CSI}?25l${MOUSE_ON}`);
draw();
process.stdout.on("resize", draw);
// Keep "n min ago" honest without ever burning CPU.
setInterval(draw, 30_000);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", onInput);
process.on("SIGINT", () => finish(1));
