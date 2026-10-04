// Headless frames of the Keys screens: bun scripts/snap-keys.tsx [--size 170x44] [--fp <fp>] [--dead]
// [--simulate] [--keys "down enter snap space snap …"]. Each `snap` prints the frame; the
// other words are key names (enter, escape, tab, space, up, down, or a single character).
// Use a scratch KEYS_VAULT_DIR unless --simulate: the keys you send are real keypresses.
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
const rotate = argv.includes("--rotate") || flag("fp") || argv.includes("--dead") ? { fingerprint: flag("fp"), dead: argv.includes("--dead"), simulate: argv.includes("--simulate") } : undefined;
const steps = (flag("keys") ?? "snap").split(/\s+/).filter(Boolean);

const setup = await testRender(<App initialRoute={{ name: "keys", rotate }} cwd={process.cwd()} />, { width: w ?? 170, height: h ?? 44 });
const settle = async (ms = 150) => {
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(ms);
    await setup.renderOnce();
  }
};
await settle(300);
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
    space: () => setup.mockInput.pressKey(" "),
    up: () => setup.mockInput.pressArrow("up"),
    down: () => setup.mockInput.pressArrow("down"),
  };
  const fn = named[step];
  if (fn) fn();
  else setup.mockInput.pressKey(step);
  await settle();
}
setup.renderer.destroy();
process.exit(0);
