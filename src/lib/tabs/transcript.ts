import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WSL_DISTRO } from "../platform.ts";

// Claude Code transcripts for `tabs`: where a session's .jsonl lives (Windows
// or inside the WSL distro, read over \\wsl.localhost) and the last prompt a
// person actually typed into it. Reads only the file's tail.

const PROMPT_MAX = 160;

/** `G:\code\x` / `/w/code/x` → the folder name Claude Code files the project under. */
export function mangle(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function projectsDir(platform: "windows" | "wsl"): string {
  if (platform === "windows") return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
  const user = process.env.TABS_WSL_USER || userInfo().username;
  return `\\\\wsl.localhost\\${WSL_DISTRO}\\home\\${user}\\.claude\\projects`;
}

/** The session's transcript, or null when it's gone. Falls back to a scan of every project folder. */
export function transcriptPath(platform: "windows" | "wsl", cwd: string, sessionId: string): string | null {
  const dir = projectsDir(platform);
  const direct = join(dir, mangle(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(dir)) {
      const p = join(dir, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    // no projects folder at all
  }
  return null;
}

const TextBlock = z.object({ type: z.string(), text: z.string().optional() });
const UserLine = z.object({
  type: z.literal("user"),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  message: z.object({ content: z.union([z.string(), z.array(TextBlock)]) }),
});

/**
 * User lines nobody typed: harness wrappers (<system-reminder>, <command-…>,
 * <task-notification>, any other leading tag), teammate messages, and the
 * summary a compaction starts the next stretch with.
 */
const NOT_TYPED = /^\s*(<[A-Za-z][\w-]*[\s/>]|Another Claude session sent a message|This session is being continued)/;
/** A paste is still a prompt: keep the words around it. */
const PASTE = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g;

function promptOf(line: string): string | null {
  if (!line.includes('"type":"user"') || line.includes('"tool_use_id"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = UserLine.safeParse(raw);
  if (!parsed.success || parsed.data.isMeta || parsed.data.isCompactSummary) return null;
  const c = parsed.data.message.content;
  const joined = typeof c === "string" ? c : c.filter((b) => b.type === "text" && b.text).map((b) => b.text ?? "").join(" ");
  const text = joined.replace(PASTE, " [paste] ");
  if (!text.trim() || NOT_TYPED.test(text)) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.slice(0, PROMPT_MAX);
}

/** The newest real user prompt in a transcript, "" when none is found in the last ~16 MB. */
export function lastPrompt(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    // Widen the tail until a prompt turns up: most sessions answer in the first window.
    for (const want of [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      // The first line is probably cut mid-way unless we read the whole file.
      const from = len < size ? 1 : 0;
      for (let i = lines.length - 1; i >= from; i--) {
        const p = promptOf(lines[i] ?? "");
        if (p !== null) return p;
      }
      if (len === size) break;
    }
    return "";
  } finally {
    closeSync(fd);
  }
}
