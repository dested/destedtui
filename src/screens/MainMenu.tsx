import { useKeyboard } from "@opentui/react";
import { T } from "../theme.ts";
import { ListPicker, type ListItem } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import type { Discovery } from "../lib/discovery.ts";
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
      icon: "🖳",
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
    { id: "ports", icon: "⚡", title: "Port Killer", subtitle: "see & kill whatever squats on your dev ports", badge: "coming soon", disabled: true },
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
          visible={14}
          onSelect={(item) => {
            if (item.id === "scripts") go({ name: "scripts" });
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
