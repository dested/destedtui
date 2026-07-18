import { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { T } from "../theme.ts";
import { ListPicker, type ListItem } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import type { Discovery, PackageInfo } from "../lib/discovery.ts";
import type { Route } from "../routes.ts";

interface Props {
  discovery: Discovery;
  go: (route: Route) => void;
  back: () => void;
}

interface Entry {
  pkg: PackageInfo;
  script: string;
  command: string;
}

const PM_COLORS: Record<string, string> = { bun: "#f472b6", pnpm: "#e0af68", yarn: "#7dcfff", npm: "#f7768e" };

function score(entry: Entry, q: string): number {
  if (!q) return 1;
  const script = entry.script.toLowerCase();
  const pkg = entry.pkg.name.toLowerCase();
  const hay = `${pkg} ${script}`;
  if (script.startsWith(q)) return 100;
  if (script.includes(q)) return 80;
  if (pkg.includes(q)) return 60;
  if (hay.includes(q)) return 50;
  // subsequence match
  let i = 0;
  for (const c of hay) if (c === q[i] && ++i === q.length) return 20;
  return 0;
}

export function Scripts({ discovery, go, back }: Props) {
  const [filter, setFilter] = useState("");

  const entries = useMemo<Entry[]>(
    () =>
      discovery.packages.flatMap((pkg) =>
        Object.entries(pkg.scripts).map(([script, command]) => ({ pkg, script, command })),
      ),
    [discovery],
  );

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    const scored = entries
      .map((e) => ({ e, s: score(e, q) }))
      .filter(({ s }) => s > 0);
    scored.sort((a, b) => b.s - a.s || a.e.script.localeCompare(b.e.script));
    return scored.map(({ e }) => e);
  }, [entries, q]);

  useKeyboard((key) => {
    if (key.name === "escape") back();
  });

  const items: ListItem[] = filtered.map((e, i) => ({
    id: `${e.pkg.dir}::${e.script}::${i}`,
    icon: "▶",
    title: e.script,
    subtitle: `${e.pkg.name}${e.pkg.rel !== "." ? ` (${e.pkg.rel})` : ""} — ${e.command.slice(0, 60)}`,
    badge: e.pkg.pm,
    badgeColor: PM_COLORS[e.pkg.pm] ?? T.dim,
  }));

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" scripts "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: T.border,
          titleColor: T.green,
          margin: 1,
          marginTop: 0,
          padding: 1,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        <box
          style={{
            border: true,
            borderStyle: "single",
            borderColor: T.border,
            height: 3,
            marginBottom: 1,
            paddingLeft: 1,
          }}
        >
          <input placeholder="type to filter scripts..." focused onInput={setFilter} />
        </box>
        <ListPicker
          items={items}
          visible={16}
          resetKey={q}
          emptyText={entries.length === 0 ? "No package.json scripts found under this directory" : "No scripts match"}
          onSelect={(_item, index) => {
            const entry = filtered[index];
            if (entry) go({ name: "process", pkg: entry.pkg, script: entry.script });
          }}
        />
      </box>
      <Footer
        hints={[
          ["type", "filter"],
          ["↑↓", "select"],
          ["enter", "run"],
          ["esc", "back"],
        ]}
      />
    </box>
  );
}
