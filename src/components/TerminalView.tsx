import { createElement } from "react";
import {
  Renderable,
  RGBA,
  TextAttributes,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core";
import { extend } from "@opentui/react";
import type { IBufferCell } from "@xterm/headless";
import { T } from "../theme.ts";
import { term, type TermSession } from "../lib/term.ts";

/** Literal ESC bytes break this repo's edit tools — build sequences from "\x1b". */
const ESC = "\x1b";
/** Lines moved per wheel notch when scrolling our own scrollback. */
const WHEEL_LINES = 3;

const DEFAULT_FG = RGBA.fromHex(T.fg);
const DEFAULT_BG = RGBA.fromHex(T.bg);

/** Standard xterm 256-colour palette → RGBA, built once. */
const PALETTE: RGBA[] = buildPalette();

function buildPalette(): RGBA[] {
  const p: RGBA[] = [];
  // 0–15: the classic ANSI 16 (VGA-ish, matches what most TUIs assume).
  const base = [
    [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
    [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
  ];
  for (const [r, g, b] of base) p.push(RGBA.fromInts(r!, g!, b!, 255));
  // 16–231: 6×6×6 cube.
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) p.push(RGBA.fromInts(steps[r]!, steps[g]!, steps[b]!, 255));
  // 232–255: 24-step grayscale.
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(RGBA.fromInts(v, v, v, 255));
  }
  return p;
}

function fgOf(cell: IBufferCell): RGBA {
  if (cell.isFgDefault()) return DEFAULT_FG;
  const v = cell.getFgColor();
  if (cell.isFgPalette()) return PALETTE[v] ?? DEFAULT_FG;
  return RGBA.fromInts((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 255);
}

function bgOf(cell: IBufferCell): RGBA {
  if (cell.isBgDefault()) return DEFAULT_BG;
  const v = cell.getBgColor();
  if (cell.isBgPalette()) return PALETTE[v] ?? DEFAULT_BG;
  return RGBA.fromInts((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 255);
}

export interface TerminalViewOptions extends RenderableOptions<TerminalViewRenderable> {
  session?: TermSession;
}

/**
 * Draws one session's xterm-headless cell grid straight into opentui's native
 * buffer via setCell — a real terminal emulator surface, not React spans. It
 * repaints on PTY output (per-session data subscription) and on focus/mode
 * changes (global subscription), and resizes the PTY to match its own cell box.
 */
export class TerminalViewRenderable extends Renderable {
  private _session: TermSession | null = null;
  private unsubData: (() => void) | null = null;
  private unsubGlobal: (() => void) | null = null;

  constructor(ctx: RenderContext, options: TerminalViewOptions) {
    super(ctx, options);
    this.unsubGlobal = term.subscribeGlobal(() => this.requestRender());
    this.onMouseScroll = (event) => this.handleScroll(event);
    if (options.session) this.session = options.session;
  }

  /**
   * The wheel does the right thing depending on what's on screen:
   *  - app reading the mouse (claude, htop) → forward an SGR wheel event so the
   *    app scrolls its own view;
   *  - alt-screen pager with no mouse tracking (less, man) → arrow up/down;
   *  - plain shell → scroll our own xterm scrollback (rendered from viewportY).
   */
  private handleScroll(event: MouseEvent): void {
    const s = this._session;
    const info = event.scroll;
    if (!s || !info || s.status !== "running") return;
    const dir = info.direction === "up" ? -1 : info.direction === "down" ? 1 : 0;
    if (dir === 0) return;
    event.preventDefault();

    const t = s.term;
    if (t.modes.mouseTrackingMode !== "none") {
      const col = Math.max(1, (event.x | 0) - (this.x | 0) + 1);
      const row = Math.max(1, (event.y | 0) - (this.y | 0) + 1);
      const button = dir < 0 ? 64 : 65; // wheel up / down in SGR mouse encoding
      term.write(s.id, `${ESC}[<${button};${col};${row}M`);
      return;
    }
    if (t.buffer.active.type === "alternate") {
      const app = t.modes.applicationCursorKeysMode;
      const key = dir < 0 ? (app ? `${ESC}OA` : `${ESC}[A`) : (app ? `${ESC}OB` : `${ESC}[B`);
      term.write(s.id, key.repeat(WHEEL_LINES));
      return;
    }
    t.scrollLines(dir * WHEEL_LINES);
    this.requestRender();
  }

  get session(): TermSession | null {
    return this._session;
  }

  set session(s: TermSession | null) {
    if (this._session === s) return;
    this.unsubData?.();
    this._session = s;
    if (s) {
      this.unsubData = term.subscribeData(s.id, () => this.requestRender());
      this.syncSize();
    }
    this.requestRender();
  }

  private syncSize(): void {
    const s = this._session;
    if (!s) return;
    const cols = this.width | 0;
    const rows = this.height | 0;
    if (cols > 0 && rows > 0) term.resize(s.id, cols, rows);
  }

  protected onResize(): void {
    this.syncSize();
    this.requestRender();
  }

  protected destroySelf(): void {
    this.unsubData?.();
    this.unsubGlobal?.();
    super.destroySelf();
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    const s = this._session;
    const cols = this.width | 0;
    const rows = this.height | 0;
    const ox = this.x | 0;
    const oy = this.y | 0;
    if (!s || cols <= 0 || rows <= 0) return;

    const active = s.term.buffer.active;
    // viewportY (not baseY) so wheel-scrolling into the scrollback actually shows;
    // at the bottom the two are equal, so normal use is unchanged.
    const top = active.viewportY;
    const cursorAbsY = active.baseY + active.cursorY;
    // Hide the cursor when scrolled off the bottom — it'd otherwise invert a
    // random scrollback cell.
    const showCursor = term.focused(s.id) && s.status === "running" && active.viewportY === active.baseY;

    for (let row = 0; row < rows; row++) {
      const line = active.getLine(top + row);
      for (let col = 0; col < cols; col++) {
        const cell = line?.getCell(col);
        let ch = cell ? cell.getChars() : "";
        if (!ch) ch = " ";
        let fg = cell ? fgOf(cell) : DEFAULT_FG;
        let bg = cell ? bgOf(cell) : DEFAULT_BG;
        let attrs = 0;
        if (cell) {
          if (cell.isBold()) attrs |= TextAttributes.BOLD;
          if (cell.isItalic()) attrs |= TextAttributes.ITALIC;
          if (cell.isUnderline()) attrs |= TextAttributes.UNDERLINE;
          if (cell.isDim()) attrs |= TextAttributes.DIM;
          if (cell.isInverse()) {
            const t = fg;
            fg = bg;
            bg = t;
          }
        }
        // Block cursor: invert the cell under it (compared in absolute buffer
        // coords since `top` is the scroll viewport, not baseY).
        if (showCursor && top + row === cursorAbsY && col === active.cursorX) {
          const t = fg;
          fg = bg;
          bg = t;
        }
        buffer.setCell(ox + col, oy + row, ch, fg, bg, attrs);
      }
    }
  }
}

extend({ terminalView: TerminalViewRenderable });

/** Typed wrapper around the registered intrinsic so screens stay clean. */
export function TerminalView({ session }: { session: TermSession }) {
  return createElement("terminalView", { session, style: { flexGrow: 1 } });
}
