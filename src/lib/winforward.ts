// WSL → Windows. A few screens are Windows-only (startup and bx drive Windows
// servers and browsers; keys is the one DPAPI vault). In the Linux build their
// tiles hand the terminal to the Windows bin through interop and take it back
// when that exits. Same env contract as bin/launch.mjs's forwardToWindows.

import { existsSync } from "node:fs";
import type { Route } from "../routes.ts";
import { IS_WIN, isWsl, WIN_WSL_ROOT, winBin } from "./platform.ts";

export interface WinTarget {
  /** the bun-linked Windows bin (`destedtui` → destedtui.exe) */
  bin: string;
  args: string[];
  /** Pin the Windows side's projects root to W:\code. keys doesn't: it looks under W:\code and G:\code itself. */
  pinRoot: boolean;
}

/** The Windows bin a route runs as on Linux, or null when it runs here. */
export function windowsTarget(route: Route): WinTarget | null {
  if (IS_WIN) return null;
  switch (route.name) {
    case "startup":
      return { bin: "destedtui", args: ["--startup"], pinRoot: true };
    case "bx":
      return { bin: "destedtui", args: route.log ? ["--bx", "--log"] : ["--bx"], pinRoot: true };
    case "bxProfiles":
      return { bin: "destedtui", args: ["--bx"], pinRoot: true };
    case "keys":
      return { bin: "keys", args: [], pinRoot: false };
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
 * A pinned target gets the projects root as `W:\code` through WSLENV, so the
 * cwd resolves on the Windows side; DESTEDTUI_WIN_PROJECTS_ROOT overrides.
 */
export async function runWindowsBin(target: WinTarget, cwd: string): Promise<number> {
  live++;
  const root = process.env.DESTEDTUI_WIN_PROJECTS_ROOT || (target.pinRoot ? WIN_WSL_ROOT : undefined);
  try {
    const proc = Bun.spawn([winBin(target.bin), ...target.args], {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
      env: root
        ? { ...process.env, DESTEDTUI_PROJECTS_ROOT: root, WSLENV: [process.env.WSLENV, "DESTEDTUI_PROJECTS_ROOT"].filter(Boolean).join(":") }
        : process.env,
    });
    return await proc.exited;
  } catch {
    return 1;
  } finally {
    live--;
  }
}
