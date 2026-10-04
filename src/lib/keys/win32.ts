// Windows plumbing for the key vault, through bun:ffi like lib/ports.ts:
// DPAPI (CryptProtectData / CryptUnprotectData, CurrentUser scope) for the vault
// blob, and the clipboard for getting a console-made key in without it ever
// becoming an argv token or a line in a Claude transcript.
//
// Memory the OS hands back (DPAPI's output blob, the clipboard's global handle)
// is addressed as a plain u64 and copied out with RtlMoveMemory, so no number
// ever has to be forced into bun's branded Pointer type.

import { dlopen, FFIType, ptr } from "bun:ffi";

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x2;

function load() {
  const crypt32 = dlopen("crypt32.dll", {
    CryptProtectData: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    CryptUnprotectData: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  const kernel32 = dlopen("kernel32.dll", {
    LocalFree: { args: [FFIType.u64], returns: FFIType.u64 },
    RtlMoveMemory: { args: [FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.void },
    GetLastError: { args: [], returns: FFIType.u32 },
    GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    GlobalLock: { args: [FFIType.u64], returns: FFIType.u64 },
    GlobalUnlock: { args: [FFIType.u64], returns: FFIType.i32 },
    GlobalSize: { args: [FFIType.u64], returns: FFIType.u64 },
    GlobalFree: { args: [FFIType.u64], returns: FFIType.u64 },
  });
  // Same export, other direction: our buffer → an OS-owned address.
  const copyIn = dlopen("kernel32.dll", {
    RtlMoveMemory: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.void },
  });
  const user32 = dlopen("user32.dll", {
    OpenClipboard: { args: [FFIType.u64], returns: FFIType.i32 },
    CloseClipboard: { args: [], returns: FFIType.i32 },
    EmptyClipboard: { args: [], returns: FFIType.i32 },
    GetClipboardData: { args: [FFIType.u32], returns: FFIType.u64 },
    SetClipboardData: { args: [FFIType.u32, FFIType.u64], returns: FFIType.u64 },
  });
  return { c: crypt32.symbols, k: kernel32.symbols, kin: copyIn.symbols, u: user32.symbols };
}

type Win32 = ReturnType<typeof load>;
let win32: Win32 | null = null;

function api(): Win32 {
  if (process.platform !== "win32") throw new Error("the key vault uses Windows DPAPI — Windows only");
  win32 ??= load();
  return win32;
}

function big(v: number | bigint): bigint {
  return typeof v === "bigint" ? v : BigInt(v);
}

/** DATA_BLOB on x64: u32 cbData, 4 bytes padding, BYTE* pbData. */
function blobOf(data: Uint8Array): Uint8Array {
  const blob = new Uint8Array(16);
  const dv = new DataView(blob.buffer);
  dv.setUint32(0, data.byteLength, true);
  dv.setBigUint64(8, data.byteLength > 0 ? BigInt(ptr(data)) : 0n, true);
  return blob;
}

/** Copy an OS-owned DATA_BLOB out into JS memory, then LocalFree it. */
function takeBlob(w: Win32, blob: Uint8Array): Uint8Array {
  const dv = new DataView(blob.buffer);
  const len = dv.getUint32(0, true);
  const addr = dv.getBigUint64(8, true);
  const out = new Uint8Array(len);
  if (len > 0) w.k.RtlMoveMemory(ptr(out), addr, BigInt(len));
  if (addr !== 0n) w.k.LocalFree(addr);
  return out;
}

/** Encrypt for the current Windows user. Only this user on this machine can decrypt. */
export function protect(plain: Uint8Array): Uint8Array {
  const w = api();
  const input = blobOf(plain);
  const output = new Uint8Array(16);
  const ok = w.c.CryptProtectData(ptr(input), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(output));
  if (!ok) throw new Error(`CryptProtectData failed (win32 error ${w.k.GetLastError()})`);
  return takeBlob(w, output);
}

export function unprotect(cipher: Uint8Array): Uint8Array {
  const w = api();
  const input = blobOf(cipher);
  const output = new Uint8Array(16);
  const ok = w.c.CryptUnprotectData(ptr(input), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(output));
  if (!ok) throw new Error(`CryptUnprotectData failed (win32 error ${w.k.GetLastError()}) — wrong Windows user, or the vault is corrupt`);
  return takeBlob(w, output);
}

/** OpenClipboard fails while another app holds it; a few short retries cover that. */
async function openClipboard(w: Win32): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (w.u.OpenClipboard(0n)) return;
    await Bun.sleep(30);
  }
  throw new Error("the clipboard is busy (another app has it open) — try again");
}

/** The clipboard's text, or "" when it holds no text. */
export async function readClipboard(): Promise<string> {
  const w = api();
  await openClipboard(w);
  try {
    const handle = big(w.u.GetClipboardData(CF_UNICODETEXT));
    if (handle === 0n) return "";
    const size = Number(big(w.k.GlobalSize(handle)));
    const addr = big(w.k.GlobalLock(handle));
    if (addr === 0n || size === 0) return "";
    try {
      const bytes = new Uint8Array(size);
      w.k.RtlMoveMemory(ptr(bytes), addr, BigInt(size));
      const text = new TextDecoder("utf-16le").decode(bytes);
      const nul = text.indexOf("\u0000");
      return nul >= 0 ? text.slice(0, nul) : text;
    } finally {
      w.k.GlobalUnlock(handle);
    }
  } finally {
    w.u.CloseClipboard();
  }
}

/** Empty the clipboard so the key doesn't sit there waiting for the next paste. */
export async function clearClipboard(): Promise<void> {
  const w = api();
  await openClipboard(w);
  try {
    w.u.EmptyClipboard();
  } finally {
    w.u.CloseClipboard();
  }
}

/** Put plain text on the clipboard (used by the self-test only; never for a key). */
export async function writeClipboard(text: string): Promise<void> {
  const w = api();
  const bytes = new Uint8Array(Buffer.from(`${text}\u0000`, "utf16le"));
  const mem = big(w.k.GlobalAlloc(GMEM_MOVEABLE, BigInt(bytes.byteLength)));
  if (mem === 0n) throw new Error("GlobalAlloc failed");
  const addr = big(w.k.GlobalLock(mem));
  w.kin.RtlMoveMemory(addr, ptr(bytes), BigInt(bytes.byteLength));
  w.k.GlobalUnlock(mem);
  await openClipboard(w);
  try {
    w.u.EmptyClipboard();
    // On success the system owns `mem`; only free it if the hand-off failed.
    if (big(w.u.SetClipboardData(CF_UNICODETEXT, mem)) === 0n) w.k.GlobalFree(mem);
  } finally {
    w.u.CloseClipboard();
  }
}
