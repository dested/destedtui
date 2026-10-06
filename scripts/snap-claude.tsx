// Headless frames of the Claude usage screen (or `--route ports|procs|keys|rotate|rotate-dead|term|menu`; rotate ones simulate): bun scripts/snap-claude.tsx [--size 170x44]
// [--keys "2 snap right right snap d snap …"]. Each `snap` prints the frame; `waitN` waits N ms;
// `click:<label>` clicks the first on-screen occurrence of <label> (`_` stands for a space,
// `click:^<label>` the last);
// the other words are key names (enter, escape, tab, up, down, left, right, or a single character).
// Read-only — it reads ~/.claude/projects and the usage cache, never writes a transcript.
// Use this, not tmux, to judge alignment: psmux drops cursor-skipped spaces in diffed rows.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("not wrapped in act")) return;
  consoleError(...args);
};
const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/App.tsx");

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [w, h] = (flag("size") ?? "170x44").split("x").map(Number);
const steps = (flag("keys") ?? "snap").split(/\s+/).filter(Boolean);

const routeName = flag("route") ?? "claude";
// rotate / rotate-dead always open in simulate mode: every step is a dry run.
const route = routeName === "rotate" ? { name: "keys" as const, rotate: { simulate: true } } : routeName === "rotate-dead" ? { name: "keys" as const, rotate: { dead: true, simulate: true } } : routeName === "keys" ? { name: "keys" as const } : routeName === "ports" ? { name: "ports" as const } : routeName === "procs" ? { name: "procs" as const } : routeName === "term" ? { name: "term" as const } : routeName === "menu" ? { name: "menu" as const } : { name: "claude" as const };
const setup = await testRender(<App initialRoute={route} cwd={process.cwd()} />, { width: w ?? 170, height: h ?? 44 });
const settle = async (ms = 120) => {
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(ms);
    await setup.renderOnce();
  }
};
// The cache loads a tick after the first paint; wait for the summary line.
if (route.name === "claude") for (let i = 0; i < 100 && !setup.captureCharFrame().includes("API-equiv"); i++) await settle(50);
else await settle(300);
let n = 0;
for (const step of steps) {
  if (step === "snap") {
    console.log(`\n=================== frame ${++n} ===================`);
    console.log(setup.captureCharFrame());
    continue;
  }
  if (step.startsWith("click:")) {
    // `click:^label` searches from the bottom (bars sit below the rows).
    const fromBottom = step.startsWith("click:^");
    const label = step.slice(fromBottom ? 7 : 6).replaceAll("_", " ");
    const lines = setup.captureCharFrame().split(String.fromCharCode(10));
    const y = fromBottom ? lines.findLastIndex((l) => l.includes(label)) : lines.findIndex((l) => l.includes(label));
    if (y < 0) console.log(`click: "${label}" not on screen`);
    else await setup.mockMouse.click((lines[y] ?? "").indexOf(label) + 1, y);
    await settle();
    continue;
  }
  if (step.startsWith("wait")) {
    await settle(Number(step.slice(4)) || 1000);
    continue;
  }
  const named: Record<string, () => void> = {
    enter: () => setup.mockInput.pressEnter(),
    escape: () => setup.mockInput.pressEscape(),
    tab: () => setup.mockInput.pressTab(),
    up: () => setup.mockInput.pressArrow("up"),
    down: () => setup.mockInput.pressArrow("down"),
    left: () => setup.mockInput.pressArrow("left"),
    right: () => setup.mockInput.pressArrow("right"),
  };
  const fn = named[step];
  if (fn) fn();
  else setup.mockInput.pressKey(step);
  await settle();
}
setup.renderer.destroy();
process.exit(0);
