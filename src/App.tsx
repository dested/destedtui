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
import { Startup } from "./screens/Startup.tsx";
import { Term } from "./screens/Term.tsx";
import { Projects } from "./screens/Projects.tsx";
import { Review } from "./screens/Review.tsx";
import { projectsRoot, recordProjectOpen } from "./lib/projects.ts";
import { announceCd, announceRun, emitCd } from "./lib/cd.ts";

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

  /**
   * A command shortcut: same handoff, but the directory we hand back is the one
   * the shell is already in, so `cc` doesn't move you anywhere. No frecency
   * either — a command isn't a project you opened.
   */
  const runHere = (command: string) => {
    const handedOff = emitCd(cwd, command);
    killAll();
    renderer.destroy();
    announceRun(command, handedOff);
    process.exit(0);
  };

  useKeyboard((key) => {
    // In the terminal workspace, ctrl+c must reach the focused PTY (claude, a
    // shell) — the Term screen owns quitting from there.
    if (key.ctrl && key.name === "c" && route.name !== "term") quit();
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
      {route.name === "startup" && <Startup back={stack.length > 1 ? back : quit} />}
      {route.name === "term" && <Term cwd={cwd} back={stack.length > 1 ? back : quit} />}
      {route.name === "review" && (
        <Review cwd={cwd} scope={route.scope} autoStart={route.autoStart} back={stack.length > 1 ? back : quit} />
      )}
      {route.name === "projects" && (
        <Projects
          root={projectsRoot()}
          cwd={cwd}
          choose={chooseProject}
          run={runHere}
          openStartup={() => go({ name: "startup" })}
          openTerm={() => go({ name: "term" })}
          leave={stack.length > 1 ? back : quit}
        />
      )}
      {(route.name === "scripts" || route.name === "backup" || route.name === "restore" || route.name === "pull") && !discovery && (
        <box style={{ padding: 2 }}>
          <text fg={T.dim}>scanning project...</text>
        </box>
      )}
    </box>
  );
}
