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

export function App({ initialRoute, cwd }: { initialRoute: Route; cwd: string }) {
  const renderer = useRenderer();
  const [stack, setStack] = useState<Route[]>(
    initialRoute.name === "menu" ? [{ name: "menu" }] : [{ name: "menu" }, initialRoute],
  );
  const [discovery, setDiscovery] = useState<Discovery | null>(null);

  useEffect(() => {
    // discovery is sync fs-walking; defer a tick so first paint happens instantly
    const t = setTimeout(() => setDiscovery(discover(cwd)), 10);
    return () => clearTimeout(t);
  }, [cwd]);

  const route = stack[stack.length - 1] ?? { name: "menu" as const };
  const go = (r: Route) => setStack((s) => [...s, r]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const quit = () => {
    killAll();
    renderer.destroy();
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
      {route.name === "backup" && discovery && <Backup discovery={discovery} back={back} />}
      {route.name === "restore" && discovery && <Restore discovery={discovery} back={back} />}
      {(route.name === "scripts" || route.name === "backup" || route.name === "restore") && !discovery && (
        <box style={{ padding: 2 }}>
          <text fg={T.dim}>scanning project...</text>
        </box>
      )}
    </box>
  );
}
