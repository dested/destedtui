// Headless frames of the Claude usage screen: bun scripts/snap-claude.tsx [--size 170x44]
// [--keys "2 snap right right snap d snap …"]. Each `snap` prints the frame; `waitN` waits N ms;
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

const setup = await testRender(<App initialRoute={{ name: "claude" }} cwd={process.cwd()} />, { width: w ?? 170, height: h ?? 44 });
const settle = async (ms = 120) => {
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(ms);
    await setup.renderOnce();
  }
};
// The cache loads a tick after the first paint; wait for the summary line.
for (let i = 0; i < 100 && !setup.captureCharFrame().includes("API-equiv"); i++) await settle(50);
let n = 0;
for (const step of steps) {
  if (step === "snap") {
    console.log(`\n=================== frame ${++n} ===================`);
    console.log(setup.captureCharFrame());
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
