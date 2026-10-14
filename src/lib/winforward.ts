// WSL → Windows. A few screens are Windows-only (startup and bx drive Windows
// servers and browsers; keys is the one DPAPI vault). In the Linux build their
// tiles hand the terminal to the Windows bin through interop and take it back
// when that exits. Same env contract as bin/launch.mjs's forwardToWindows.

import { existsSync } from "node:fs";
import type { Route } from "../routes.ts";
import { IS_WIN, isWsl, winBin } from "./platform.ts";

export interface WinTarget {
  /** the bun-linked Windows bin (`destedtui` → destedtui.exe) */
  bin: string;
  args: string[];
}

/** The Windows bin a route runs as on Linux, or null when it runs here. */
export function windowsTarget(route: Route): WinTarget | null {
  if (IS_WIN) return null;
  switch (route.name) {
    case "startup":
      return { bin: "destedtui", args: ["--startup"] };
    case "bx":
      return { bin: "destedtui", args: route.log ? ["--bx", "--log"] : ["--bx"] };
    case "bxProfiles":
      return { bin: "destedtui", args: ["--bx"] };
    case "keys":
      return { bin: "keys", args: [] };
    default:
      return null;
  }
}

/** Why a Windows bin can't run from here, or null when it can. */
export function windowsUnavailable(bin: string): string | null {
  if (!isWsl()) return "Windows only";
  if (!existsSync(winBin(bin))) return `Windows only: ${bin}.exe isn't linked (bun link in G:\\code\\destedtui)`;
  return null;
}

let live = 0;

/** True while a Windows bin owns the terminal (the idle pause must wait). */
export function forwarding(): boolean {
  return live > 0;
}

/**
 * Run a Windows bin with the terminal handed over and resolve its exit code.
 * The projects root goes across as `W:\code` through WSLENV, so `--project`
 * and the cwd resolve on the Windows side.
 */
export async function runWindowsBin(target: WinTarget, cwd: string): Promise<number> {
  live++;
  try {
    const proc = Bun.spawn([winBin(target.bin), ...target.args], {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        DESTEDTUI_PROJECTS_ROOT: process.env.DESTEDTUI_WIN_PROJECTS_ROOT || "W:\\code",
        WSLENV: [process.env.WSLENV, "DESTEDTUI_PROJECTS_ROOT"].filter(Boolean).join(":"),
      },
    });
    return await proc.exited;
  } catch {
    return 1;
  } finally {
    live--;
  }
}
