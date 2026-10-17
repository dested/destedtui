#!/usr/bin/env node
// The `tabs` bin: a ~15 MB Node launcher around the real Bun entry (see launch.mjs).
// In WSL it forwards to the Windows tabs.exe (UI Automation, consoles and wt.exe
// are Win32), telling it which pts we're on so `tabs save` skips this tab.
import { readlinkSync } from "node:fs";
import { forwardToWindows, launch } from "./launch.mjs";

if (process.platform === "linux") {
  let tty = "";
  try {
    tty = readlinkSync("/proc/self/fd/0");
  } catch {
    // no stdin at all
  }
  // A pipe or file on stdin isn't a tab: nothing to skip.
  if (tty.startsWith("/dev/pts/")) {
    process.env.TABS_SELF_TTY = tty;
    process.env.WSLENV = [process.env.WSLENV, "TABS_SELF_TTY"].filter(Boolean).join(":");
  }
  await forwardToWindows("tabs");
} else await launch("src/tabs.tsx");
