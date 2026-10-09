import { useKeyboard } from "@opentui/react";
import { T } from "../theme.ts";
import { ListPicker, type ListItem } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import type { Discovery } from "../lib/discovery.ts";
import { projectsRoot } from "../lib/projects.ts";
import type { Route } from "../routes.ts";

interface Props {
  discovery: Discovery | null;
  go: (route: Route) => void;
  quit: () => void;
}

export function MainMenu({ discovery, go, quit }: Props) {
  const pkgCount = discovery?.packages.length ?? 0;
  const scriptCount = discovery?.packages.reduce((n, p) => n + Object.keys(p.scripts).length, 0) ?? 0;
  const dbCount = discovery?.databases.length ?? 0;

  useKeyboard((key) => {
    if (key.name === "q" && !key.ctrl) quit();
  });

  const items: ListItem[] = [
    {
      id: "projects",
      icon: "◈",
      title: "Projects",
      subtitle: "jump to any project — closes the tui and cds there",
      badge: projectsRoot(),
      badgeColor: T.teal,
    },
    {
      id: "review",
      icon: "✓",
      title: "Review",
      subtitle: "clean-context claude review — changes, commits, branch, or a PR",
      badge: "opus 4.8",
      badgeColor: T.pink,
    },
    {
      id: "startup",
      icon: "⧉",
      title: "Startup",
      subtitle: "boot all your dev servers — one live console dashboard",
      badge: "5 apps",
      badgeColor: T.orange,
    },
    {
      id: "term",
      icon: "▓",
      title: "Terminals",
      subtitle: "a multiplexer — live shells & claude sessions in panes",
      badge: "multiplexer",
      badgeColor: T.teal,
    },
    {
      id: "ports",
      icon: "◉",
      title: "Localhost",
      subtitle: "every node/bun server listening — links, cwd, kill",
      badge: "live",
      badgeColor: T.blue,
    },
    {
      id: "procs",
      icon: "▲",
      title: "Claude procs",
      subtitle: "what every claude session spun up — cpu hogs, dupes, orphans, kill",
      badge: "live",
      badgeColor: T.cyan,
    },
    {
      id: "bx",
      icon: "◈",
      title: "bx daemons",
      subtitle: "every bx browser daemon — what it's doing, who drives it, memory growth, orphans",
      badge: "live",
      badgeColor: T.teal,
    },
    {
      id: "keys",
      icon: "◆",
      title: "Keys",
      subtitle: "every AI API key — one per project, minted where possible, written to .env",
      badge: "dpapi vault",
      badgeColor: T.orange,
    },
    {
      id: "claude",
      icon: "◷",
      title: "Claude Usage",
      subtitle: "claude code cost, tokens & sessions per project — timeline, day log",
      badge: "transcripts",
      badgeColor: T.purple,
    },
    {
      id: "scripts",
      icon: "▶",
      title: "Scripts",
      subtitle: "run package.json scripts across the repo",
      badge: discovery ? `${pkgCount} pkgs · ${scriptCount} scripts` : "scanning...",
      badgeColor: T.green,
    },
    {
      id: "backup",
      icon: "⛁",
      title: "PG Backup",
      subtitle: "dump a Postgres DB to a zip in its project folder",
      badge: discovery ? (dbCount > 0 ? `${dbCount} database${dbCount === 1 ? "" : "s"}` : "no DATABASE_URL found") : "scanning...",
      badgeColor: dbCount > 0 ? T.green : T.dim,
      disabled: discovery !== null && dbCount === 0,
    },
    {
      id: "restore",
      icon: "↺",
      title: "PG Restore",
      subtitle: "restore a zip/dump/file — original server or localhost",
      badge: discovery ? (dbCount > 0 ? `${dbCount} database${dbCount === 1 ? "" : "s"}` : "from a file") : "scanning...",
      badgeColor: dbCount > 0 ? T.green : T.cyan,
    },
    {
      id: "localdb",
      icon: "⌂",
      title: "Local Postgres",
      subtitle: "browse localhost DBs — create, drop, back up, restore into",
      badge: "localhost",
      badgeColor: T.cyan,
    },
    {
      id: "pull",
      icon: "⇩",
      title: "Pull to Local",
      subtitle: "clone a remote/.env database straight into localhost",
      badge: discovery ? (dbCount > 0 ? `${dbCount} source${dbCount === 1 ? "" : "s"}` : "no DATABASE_URL found") : "scanning...",
      badgeColor: dbCount > 0 ? T.green : T.dim,
      disabled: discovery !== null && dbCount === 0,
    },
    { id: "git", icon: "⎇", title: "Git Dashboard", subtitle: "branches, dirty files, quick actions", badge: "coming soon", disabled: true },
    { id: "env", icon: "☰", title: ".env Inspector", subtitle: "diff envs, spot missing keys", badge: "coming soon", disabled: true },
    { id: "nuke", icon: "✕", title: "node_modules Nuker", subtitle: "reclaim disk from dead installs", badge: "coming soon", disabled: true },
  ];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" utilities "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: T.border,
          titleColor: T.purple,
          margin: 1,
          marginTop: 0,
          padding: 1,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        <ListPicker
          items={items}
          vimKeys
          visible={15}
          onSelect={(item) => {
            if (item.id === "projects") go({ name: "projects" });
            else if (item.id === "review") go({ name: "review" });
            else if (item.id === "startup") go({ name: "startup" });
            else if (item.id === "term") go({ name: "term" });
            else if (item.id === "ports") go({ name: "ports" });
            else if (item.id === "procs") go({ name: "procs" });
            else if (item.id === "bx") go({ name: "bx" });
            else if (item.id === "keys") go({ name: "keys" });
            else if (item.id === "claude") go({ name: "claude" });
            else if (item.id === "scripts") go({ name: "scripts" });
            else if (item.id === "backup") go({ name: "backup" });
            else if (item.id === "restore") go({ name: "restore" });
            else if (item.id === "localdb") go({ name: "localdb" });
            else if (item.id === "pull") go({ name: "pull" });
          }}
        />
      </box>
      <Footer
        hints={[
          ["↑↓", "navigate"],
          ["enter", "open"],
          ["click", "works too"],
          ["q", "quit"],
        ]}
      />
    </box>
  );
}
