/**
 * Runs scan() off the UI thread — the cold scan of ~18 GB takes most of a
 * minute. Posts progress, then `done` with how many files were (re)read; the
 * screen rereads the cache file only when that's > 0.
 */
import { scan, type ScanProgress } from "./scan.ts";

declare const self: Worker;

self.onmessage = () => {
  try {
    let last: ScanProgress = { done: 0, total: 0, read: 0, bytes: 0 };
    scan((p) => {
      last = p;
      self.postMessage({ type: "progress", ...p });
    });
    self.postMessage({ type: "done", read: last.read });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
