import { writeFileSync } from "node:fs";

// Literal ESC bytes in source break this repo's editing tools — see cliffnotes.
const ESC = String.fromCharCode(0x1b);
const CYAN = `${ESC}[36m`;
const DIM = `${ESC}[90m`;
const OFF = `${ESC}[0m`;

/**
 * A child process can't change its parent shell's directory, so the shell
 * wrapper (shell/destedtui.ps1) hands us a temp file path in DESTEDTUI_CD_FILE,
 * we write the chosen directory into it, and the wrapper `Set-Location`s there
 * once we've exited. No file set = we were run without the wrapper.
 */
export function emitCd(dir: string, command?: string): boolean {
  const target = process.env.DESTEDTUI_CD_FILE;
  if (!target) return false;
  try {
    // Line 1 = where to go, line 2 (optional) = what to run once we're there.
    writeFileSync(target, command ? `${dir}\n${command}` : dir, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Printed after the renderer is torn down. Wipes the screen and the scrollback
 * first so picking a project leaves a clean terminal with one confirmation
 * line, not the remains of the picker.
 */
export function announceCd(dir: string, handedOff: boolean, command?: string): void {
  process.stdout.write(`${ESC}[2J${ESC}[3J${ESC}[H`);
  process.stdout.write(`${CYAN}➜  cd ${dir}${OFF}\n`);
  if (command) process.stdout.write(`${CYAN}➜  ${command}${OFF}\n`);
  if (!handedOff) hint();
}

/**
 * Same teardown for a command shortcut, minus the cd line: it runs where the
 * shell already is, so printing a directory would just be noise.
 */
export function announceRun(command: string, handedOff: boolean): void {
  process.stdout.write(`${ESC}[2J${ESC}[3J${ESC}[H`);
  process.stdout.write(`${CYAN}➜  ${command}${OFF}\n`);
  if (!handedOff) hint();
}

function hint(): void {
  process.stdout.write(`${DIM}   (shell can't follow — run: destedtui --install-shell)${OFF}\n`);
}
