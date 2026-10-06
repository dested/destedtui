// Process naming shared by the localhost and procs screens: which project a
// cwd belongs to, and a command line cut down to what a human reads.

import { projectsRoot } from "./projects.ts";


export function leaf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

export function exeName(exe: string): string {
  return exe.replace(/\.exe$/i, "");
}

/** `G:\code\frozenropes-next\apps\web` → { name: "frozenropes-next", sub: "apps/web" }. */
export function projectOf(cwd: string, root: string): { name: string; sub: string } {
  if (!cwd) return { name: "", sub: "" };
  const norm = (s: string) => s.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
  const r = norm(root);
  const c = norm(cwd);
  if (c.startsWith(`${r}\\`)) {
    const parts = cwd.slice(root.replace(/[\\/]+$/, "").length + 1).split(/[\\/]+/).filter(Boolean);
    return { name: parts[0] ?? leaf(cwd), sub: parts.slice(1).join("/") };
  }
  return { name: leaf(cwd) || cwd, sub: "" };
}

function tokenize(cmdline: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(cmdline); m; m = re.exec(cmdline)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/**
 * Make a command line readable: the runtime by its short name, node_modules
 * entry points by their package (`node …\expo\bin\cli start` → `expo start`),
 * paths inside the cwd made relative.
 */
export function prettyCommand(cmdline: string, cwd: string, exe: string): string {
  const rootPrefix = `${projectsRoot().replace(/[\\/]+$/, "")}\\`.toLowerCase();
  const tokens = tokenize(cmdline);
  if (tokens.length === 0) return exeName(exe);
  const head = exeName(leaf(tokens[0] ?? ""));
  const cwdPrefix = cwd ? `${cwd.replace(/[\\/]+$/, "")}\\`.toLowerCase() : null;
  let viaPackage = false;
  const rest = tokens.slice(1).map((t) => {
    const nm = /node_modules[\\/]+(?:\.bin[\\/]+\.\.[\\/]+)?(@[^\\/]+[\\/]+[^\\/]+|[^\\/]+)/i.exec(t);
    if (nm?.[1]) {
      viaPackage = true;
      return nm[1].replace(/\\/g, "/");
    }
    if (cwdPrefix && t.toLowerCase().startsWith(cwdPrefix)) return t.slice(cwdPrefix.length);
    // another project's file (G:/code/bx/src/daemon.ts) -> bx/src/daemon.ts
    if (t.toLowerCase().startsWith(rootPrefix)) return t.slice(rootPrefix.length);
    return t;
  });
  const runtime = head.toLowerCase();
  // `node <pkg entry> …` reads better as just `<pkg> …`.
  if (viaPackage && (runtime === "node" || runtime === "bun") && rest.length > 0) return rest.join(" ");
  return [head, ...rest].join(" ");
}
