// Windows ↔ WSL. destedtui runs natively on Windows and in the `sal` WSL
// distro; this is everything that has to know which side it's on, or reach
// across. Path rules (both directions): `W:\x` ↔ `/w/x` (W: is a subst of
// \\wsl.localhost\sal\w), `\\wsl.localhost\sal\x` / `\\wsl$\sal\x` ↔ `/x`,
// `/mnt/c/x` ↔ `C:\x`.

import { existsSync } from "node:fs";
import { userInfo } from "node:os";

export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

/** The distro the W: drive and the Linux build live in. */
export const WSL_DISTRO = process.env.DESTEDTUI_WSL_DISTRO || "sal";

/** The projects root on each side. */
export const WIN_DEFAULT_ROOT = "G:\\code";
export const LINUX_DEFAULT_ROOT = "/w/code";

/** True inside WSL, where Windows binaries run through interop. */
export function isWsl(): boolean {
  return IS_LINUX && (Boolean(process.env.WSL_DISTRO_NAME) || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"));
}

/** The Windows user's home folder as Linux sees it (`/mnt/c/Users/dested`). */
export function winHome(): string {
  return process.env.DESTEDTUI_WIN_HOME || `/mnt/c/Users/${userInfo().username}`;
}

/** The Windows-side bun-linked bins (`destedtui.exe`, `keys.exe`), Linux path. */
export function winBin(name: string): string {
  return `${winHome()}/.bun/bin/${name}.exe`;
}

/**
 * A Windows process launched from WSL starts in `\\wsl.localhost\sal\w\…` (or
 * `\\wsl$\sal\w\…`). Fold that back to the `W:\…` form every other Windows
 * tool uses, so project resolution sees the same path either way. Anything
 * else comes back untouched.
 */
export function normalizeWslUnc(p: string): string {
  const m = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)[\\/]w(?=[\\/]|$)(.*)$/i.exec(p);
  if (!m || m[1]?.toLowerCase() !== WSL_DISTRO.toLowerCase()) return p;
  const rest = (m[2] ?? "").replace(/\//g, "\\");
  return `W:${rest || "\\"}`;
}

/** `W:\code\x` → `/w/code/x`; `\\wsl.localhost\sal\x` → `/x`; null when the path isn't in the distro. */
export function winToLinux(p: string): string | null {
  const w = /^[Ww]:(?:[\\/](.*))?$/.exec(p);
  if (w) return `/w/${(w[1] ?? "").replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/w";
  const unc = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(p);
  if (unc && unc[1]?.toLowerCase() === WSL_DISTRO.toLowerCase()) return `/${(unc[2] ?? "").replace(/\\/g, "/")}`;
  return null;
}
