/**
 * Reads every Claude Code transcript under ~/.claude/projects into a compact,
 * incrementally maintained cache (~/.destedtui/claude-usage.json).
 *
 * A transcript is append-only JSONL, so each file remembers the byte offset of
 * its last complete line: a grown file is read from there, an untouched one is
 * skipped by size+mtime, and a shrunk one is reparsed. The cold scan of ~18 GB
 * takes ~45s; a warm one is a stat per file.
 *
 * Per message we keep a flat tuple (see STRIDE), never a dollar figure — cost is
 * priced at view time so a pricing fix reprices history without a rescan.
 *
 * Dedupe: Claude Code writes one line per content block, each carrying the same
 * message id + requestId + usage, so a message is counted once per file (the
 * copy with the most output tokens wins). Resumed sessions copy history into a
 * new file; the view drops those by hash across files.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { CONFIG_DIR } from "../config.ts";

export const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
export const CACHE_PATH = join(CONFIG_DIR, "claude-usage.json");
const CACHE_VERSION = 1;

/** Flat message tuple: [hash, tsSec, modelIdx, input, output, cacheRead, cacheWrite5m, cacheWrite1h, fast]. */
export const STRIDE = 9;
export const F = { hash: 0, ts: 1, model: 2, input: 3, output: 4, cacheRead: 5, cw5: 6, cw1: 7, fast: 8 } as const;

const fileSchema = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  offset: z.number(),
  sessionId: z.string(),
  /** Subagent transcript (lives under <session>/subagents/). */
  sub: z.boolean(),
  /** Subagent type from its .meta.json / attribution, e.g. "board-scribe". */
  agent: z.string().nullable(),
  cwd: z.string().nullable(),
  branch: z.string().nullable(),
  title: z.string().nullable(),
  /** Human prompts typed into the session (tool results and meta lines excluded). */
  prompts: z.number(),
  /** Sorted unique epoch minutes in which the transcript recorded anything. */
  mins: z.array(z.number()),
  /** Messages, STRIDE numbers each. */
  m: z.array(z.number()),
});
export type FileEntry = z.infer<typeof fileSchema>;

const cacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  scannedAt: z.number(),
  models: z.array(z.string()),
  files: z.record(z.string(), fileSchema),
});
export type UsageCache = z.infer<typeof cacheSchema>;

export function readCache(): UsageCache | null {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(CACHE_PATH, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCache(cache: UsageCache): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, CACHE_PATH);
}

/** Every transcript path, skipping the tool-results spill folders. */
function listTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "tool-results") walk(p);
      } else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export interface ScanProgress {
  done: number;
  total: number;
  /** Files actually (re)read this scan — the rest were cache hits. */
  read: number;
  bytes: number;
}

/** What scanWorker.ts posts back — parsed on the UI side, never trusted raw. */
export const workerMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), done: z.number(), total: z.number(), read: z.number(), bytes: z.number() }),
  z.object({ type: z.literal("done"), read: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

const NL = 0x0a;
const decoder = new TextDecoder();

/** Bytes [offset, size) of a file — a grown transcript is read from where we left off, not from 0. */
function readFrom(path: string, offset: number, size: number): Uint8Array {
  const buf = new Uint8Array(Math.max(0, size - offset));
  const fd = openSync(path, "r");
  try {
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function hashKey(k: string): number {
  return Number(BigInt.asUintN(52, BigInt(Bun.hash(k))));
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull the top-level "timestamp" off a line without parsing it (user lines can be megabytes of tool output). */
function lineTimestamp(line: string): number | null {
  const at = line.lastIndexOf('"timestamp":"');
  if (at < 0) return null;
  const start = at + 13;
  const t = Date.parse(line.slice(start, line.indexOf('"', start)));
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function subagentType(path: string): string | null {
  try {
    const meta: unknown = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return isObj(meta) ? str(meta.agentType) : null;
  } catch {
    return null;
  }
}

/**
 * Parse `text` (whole lines only) into `entry`, appending messages and minutes.
 * `seen` maps a message key hash → its tuple index within entry.m.
 */
function ingest(text: string, entry: FileEntry, seen: Map<number, number>, models: string[], modelIdx: Map<string, number>, mins: Set<number>): void {
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf("\n", i);
    if (j < 0) j = text.length;
    const line = text.slice(i, j);
    i = j + 1;
    if (line.length < 2) continue;

    const isAssistant = line.includes('"type":"assistant"') && line.includes('"usage":{');
    if (!isAssistant) {
      if (line.includes('"type":"ai-title"')) {
        try {
          const d: unknown = JSON.parse(line);
          if (isObj(d)) entry.title = str(d.aiTitle) ?? entry.title;
        } catch {}
        continue;
      }
      if (line.includes('"type":"user"')) {
        const ts = lineTimestamp(line);
        if (ts !== null) mins.add(Math.floor(ts / 60));
        if (!line.includes('"tool_use_id"') && !line.includes('"isMeta":true') && !line.includes('"isSidechain":true')) entry.prompts++;
      }
      continue;
    }

    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(d) || !isObj(d.message)) continue;
    const msg = d.message;
    const usage = msg.usage;
    if (!isObj(usage)) continue;
    const ts = Date.parse(str(d.timestamp) ?? "");
    if (Number.isNaN(ts)) continue;
    const tsSec = Math.floor(ts / 1000);
    mins.add(Math.floor(tsSec / 60));

    entry.cwd ??= str(d.cwd);
    entry.branch ??= str(d.gitBranch);
    if (entry.sub) entry.agent ??= str(d.attributionAgent);

    const model = str(msg.model) ?? "unknown";
    let mi = modelIdx.get(model);
    if (mi === undefined) {
      mi = models.length;
      models.push(model);
      modelIdx.set(model, mi);
    }
    const cc = isObj(usage.cache_creation) ? usage.cache_creation : null;
    const cw1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
    // Old transcripts have no TTL split: all writes were 5-minute writes then.
    const cw5 = cc ? num(cc.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens);
    const tuple = [
      hashKey(`${str(msg.id) ?? str(d.uuid) ?? line.length}:${str(d.requestId) ?? ""}`),
      tsSec,
      mi,
      num(usage.input_tokens),
      num(usage.output_tokens),
      num(usage.cache_read_input_tokens),
      cw5,
      cw1,
      usage.speed === "fast" ? 1 : 0,
    ];
    const hash = tuple[0] ?? 0;
    const prev = seen.get(hash);
    if (prev === undefined) {
      seen.set(hash, entry.m.length / STRIDE);
      entry.m.push(...tuple);
    } else if ((tuple[F.output] ?? 0) > (entry.m[prev * STRIDE + F.output] ?? 0)) {
      for (let k = 0; k < STRIDE; k++) entry.m[prev * STRIDE + k] = tuple[k] ?? 0;
    }
  }
}

function freshEntry(path: string): FileEntry {
  const sub = basename(dirname(path)) === "subagents";
  // <project>/<session>.jsonl, or <project>/<session>/subagents/agent-x.jsonl
  const sessionId = sub ? basename(dirname(dirname(path))) : basename(path, ".jsonl");
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    sessionId,
    sub,
    agent: sub ? subagentType(path) : null,
    cwd: null,
    branch: null,
    title: null,
    prompts: 0,
    mins: [],
    m: [],
  };
}

/**
 * Bring the cache up to date with the transcripts on disk and return it.
 * Synchronous on purpose — the TUI runs it in a Worker (scanWorker.ts) so the
 * cold scan never blocks a frame; the CLI just calls it.
 */
export function scan(onProgress?: (p: ScanProgress) => void): UsageCache {
  const prev = readCache();
  const models = prev ? [...prev.models] : [];
  const modelIdx = new Map(models.map((m, i) => [m, i]));
  const files: Record<string, FileEntry> = {};
  const paths = listTranscripts(CLAUDE_PROJECTS);
  const progress: ScanProgress = { done: 0, total: paths.length, read: 0, bytes: 0 };
  let changed = !prev;
  let lastTick = 0;

  for (const path of paths) {
    progress.done++;
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const old = prev?.files[path];
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) {
      files[path] = old;
      continue;
    }
    changed = true;
    // Append-only: resume from the last complete line. A shrunk file was rewritten — start over.
    const entry = old && st.size >= old.offset ? { ...old, m: [...old.m] } : freshEntry(path);
    const seen = new Map<number, number>();
    for (let k = 0; k < entry.m.length / STRIDE; k++) seen.set(entry.m[k * STRIDE] ?? 0, k);
    const mins = new Set(entry.mins);
    try {
      const bytes = readFrom(path, entry.offset, st.size);
      const end = bytes.lastIndexOf(NL);
      if (end >= 0) {
        ingest(decoder.decode(bytes.subarray(0, end + 1)), entry, seen, models, modelIdx, mins);
        entry.offset += end + 1;
      }
      progress.bytes += bytes.length;
    } catch {
      continue;
    }
    entry.mins = [...mins].sort((a, b) => a - b);
    entry.size = st.size;
    entry.mtimeMs = st.mtimeMs;
    files[path] = entry;
    progress.read++;
    const now = performance.now();
    if (onProgress && now - lastTick > 100) {
      lastTick = now;
      onProgress({ ...progress });
    }
  }
  onProgress?.({ ...progress });

  // Claude Code deletes transcripts after cleanupPeriodDays; the cache is the
  // only record left of them, so a vanished file keeps its entry.
  for (const [path, entry] of Object.entries(prev?.files ?? {})) files[path] ??= entry;

  const cache: UsageCache = { version: CACHE_VERSION, scannedAt: Date.now(), models, files };
  if (changed) writeCache(cache);
  return cache;
}
