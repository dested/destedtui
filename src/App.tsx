import { useEffect, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { T } from "./theme.ts";
import type { Route } from "./routes.ts";
import { discover, type Discovery } from "./lib/discovery.ts";
import { killAll } from "./lib/run.ts";
import { Header } from "./components/Header.tsx";
import { MainMenu } from "./screens/MainMenu.tsx";
import { Scripts } from "./screens/Scripts.tsx";
import { ProcessView } from "./screens/ProcessView.tsx";
import { Backup } from "./screens/Backup.tsx";
import { Restore } from "./screens/Restore.tsx";
import { LocalDb } from "./screens/LocalDb.tsx";
import { Pull } from "./screens/Pull.tsx";
import { Projects } from "./screens/Projects.tsx";
import { projectsRoot, recordProjectOpen } from "./lib/projects.ts";
import { announceCd, emitCd } from "./lib/cd.ts";

export function App({ initialRoute, cwd }: { initialRoute: Route; cwd: string }) {
  const renderer = useRenderer();
  const [stack, setStack] = useState<Route[]>(() => {
    if (initialRoute.name === "menu") return [{ name: "menu" }];
    // The project picker launched from the shell is the whole app — nothing to
    // go "back" to, so esc must quit rather than drop you in the menu.
    if (initialRoute.name === "projects") return [initialRoute];
    return [{ name: "menu" }, initialRoute];
  });
  const [discovery, setDiscovery] = useState<Discovery | null>(null);

  useEffect(() => {
    // The shell-launched picker never leaves the projects screen, so scanning
    // the cwd for scripts/databases there is wasted work (it used to freeze
    // the freshly painted UI for seconds on a big directory).
    if (initialRoute.name === "projects") return;
    let stale = false;
    discover(cwd).then((d) => {
      if (!stale) setDiscovery(d);
    });
    return () => {
      stale = true;
    };
  }, [cwd, initialRoute.name]);

  const route = stack[stack.length - 1] ?? { name: "menu" as const };
  const go = (r: Route) => setStack((s) => [...s, r]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const quit = () => {
    killAll();
    renderer.destroy();
    process.exit(0);
  };

  /** Picking a project ends the session: we exist only to hand a path back. */
  const chooseProject = (dir: string, command?: string) => {
    recordProjectOpen(dir);
    const handedOff = emitCd(dir, command);
    killAll();
    renderer.destroy();
    announceCd(dir, handedOff, command);
    process.exit(0);
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") quit();
  });

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: T.bg }}>
      <Header subtitle={cwd} />
      {route.name === "menu" && <MainMenu discovery={discovery} go={go} quit={quit} />}
      {route.name === "scripts" && discovery && <Scripts discovery={discovery} go={go} back={back} />}
      {route.name === "process" && <ProcessView pkg={route.pkg} script={route.script} back={back} />}
      {route.name === "backup" && discovery && (
        <Backup discovery={discovery} back={back} presetUrl={route.presetUrl} presetLabel={route.presetLabel} />
      )}
      {route.name === "restore" && discovery && <Restore discovery={discovery} back={back} preset={route.preset} />}
      {route.name === "localdb" && <LocalDb go={go} back={back} />}
      {route.name === "pull" && discovery && <Pull discovery={discovery} back={back} />}
      {route.name === "projects" && (
        <Projects root={projectsRoot()} choose={chooseProject} leave={stack.length > 1 ? back : quit} />
      )}
      {(route.name === "scripts" || route.name === "backup" || route.name === "restore" || route.name === "pull") && !discovery && (
        <box style={{ padding: 2 }}>
          <text fg={T.dim}>scanning project...</text>
        </box>
      )}
    </box>
  );
}
