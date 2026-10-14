#!/usr/bin/env node
// The `keys` bin: a ~15 MB Node launcher around the real Bun entry (see launch.mjs).
// In WSL it forwards to the Windows keys.exe: the vault is DPAPI, Windows only.
import { forwardToWindows, launch } from "./launch.mjs";

if (process.platform === "linux") await forwardToWindows("keys");
else await launch("src/keys.tsx");
