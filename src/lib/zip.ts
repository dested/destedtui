import { createReadStream, createWriteStream } from "node:fs";
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from "fflate";

/**
 * Create a zip containing the dump file (stored — pg_dump custom format is
 * already compressed) plus a small metadata.json (deflated). Fully streaming;
 * never holds the dump in memory.
 */
export async function createBackupZip(
  zipPath: string,
  dumpPath: string,
  dumpEntryName: string,
  metadata: object,
  onProgress?: (bytesWritten: number) => void,
): Promise<void> {
  const out = createWriteStream(zipPath);
  let written = 0;
  const outDone = new Promise<void>((resolve, reject) => out.on("close", resolve).on("error", reject));

  await new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, data, final) => {
      if (err) {
        out.destroy();
        reject(err);
        return;
      }
      if (data.length) {
        written += data.length;
        out.write(Buffer.from(data));
        onProgress?.(written);
      }
      if (final) {
        out.end();
        resolve();
      }
    });

    const meta = new ZipDeflate("metadata.json", { level: 9 });
    zip.add(meta);
    meta.push(new TextEncoder().encode(JSON.stringify(metadata, null, 2)), true);

    const entry = new ZipPassThrough(dumpEntryName);
    zip.add(entry);
    const rs = createReadStream(dumpPath, { highWaterMark: 1024 * 1024 });
    rs.on("data", (chunk) => entry.push(new Uint8Array(chunk as Buffer)));
    rs.on("end", () => {
      entry.push(new Uint8Array(0), true);
      zip.end();
    });
    rs.on("error", (err) => {
      out.destroy();
      reject(err);
    });
  });

  await outDone;
}

/** Read just metadata.json from a zip without loading the whole file. */
export async function readZipMetadata(zipPath: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (!settled) {
        settled = true;
        rs.destroy();
        resolve(value);
      }
    };
    const chunks: Uint8Array[] = [];
    const unzip = new Unzip((file) => {
      if (file.name !== "metadata.json") return;
      file.ondata = (err, data, final) => {
        if (err) return finish(null);
        chunks.push(data);
        if (final) {
          try {
            const text = new TextDecoder().decode(concat(chunks));
            finish(JSON.parse(text));
          } catch {
            finish(null);
          }
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const rs = createReadStream(zipPath, { highWaterMark: 256 * 1024 });
    rs.on("data", (chunk) => {
      try {
        unzip.push(new Uint8Array(chunk as Buffer), false);
      } catch {
        finish(null);
      }
      if (settled) rs.destroy();
    });
    rs.on("end", () => {
      try {
        unzip.push(new Uint8Array(0), true);
      } catch {
        /* ignore */
      }
      finish(null);
    });
    rs.on("error", () => finish(null));
  });
}

/** Stream-extract the first entry matching predicate to destPath. Resolves to the entry name or null. */
export async function extractZipEntry(
  zipPath: string,
  predicate: (name: string) => boolean,
  destPath: string,
  onProgress?: (bytes: number) => void,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let found: string | null = null;
    let ws: ReturnType<typeof createWriteStream> | null = null;
    let bytes = 0;
    const unzip = new Unzip((file) => {
      if (found !== null || !predicate(file.name)) return;
      found = file.name;
      ws = createWriteStream(destPath);
      ws.on("error", (err) => {
        rs.destroy();
        reject(err);
      });
      file.ondata = (err, data, final) => {
        if (err) {
          rs.destroy();
          ws?.destroy();
          reject(err);
          return;
        }
        if (data.length) {
          bytes += data.length;
          ws!.write(Buffer.from(data));
          onProgress?.(bytes);
        }
        if (final) {
          ws!.end(() => resolve(found));
          rs.destroy();
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const rs = createReadStream(zipPath, { highWaterMark: 1024 * 1024 });
    rs.on("data", (chunk) => {
      try {
        unzip.push(new Uint8Array(chunk as Buffer), false);
      } catch (err) {
        rs.destroy();
        reject(err);
      }
    });
    rs.on("end", () => {
      try {
        unzip.push(new Uint8Array(0), true);
      } catch {
        /* ignore */
      }
      if (found === null) resolve(null);
    });
    rs.on("error", reject);
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
