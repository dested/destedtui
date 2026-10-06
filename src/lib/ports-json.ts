// `destedtui --ports --json`: one localhost scan printed as JSON, for other tools
// (sal-agent's /ports page). Read-only: no kill here. Shape is versioned (`v`);
// add fields, never rename them.

import { lanAddress, runProbe, scanServers, urlFor } from "./ports.ts";

/** Short, so one hung dev server can't stall the whole report. */
const PROBE_MS = 1500;

export async function runPortsJson(args: string[]): Promise<number> {
  const scan = scanServers({ all: args.includes("--all") });
  const probes = await Promise.all(
    scan.servers.map((s) => {
      const port = s.listeners[0]?.port;
      return port === undefined ? Promise.resolve(null) : runProbe(port, PROBE_MS);
    }),
  );
  const servers = scan.servers.map((s, i) => {
    const first = s.listeners[0]?.port ?? null;
    const p = probes[i] ?? null;
    return {
      pid: s.proc.pid,
      runtime: s.runtime,
      exe: s.proc.exe,
      cmdline: s.proc.cmdline,
      cwd: s.proc.cwd,
      startedAt: s.proc.startedAt,
      memory: s.proc.memory,
      exposed: s.exposed,
      listeners: s.listeners,
      url: first === null ? null : urlFor(first),
      http: p?.kind === "http",
      status: p?.status ?? null,
      title: p?.title ?? null,
    };
  });
  const out = { v: 1, at: scan.at, error: scan.error, lan: lanAddress(), servers };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return scan.error ? 1 : 0;
}
