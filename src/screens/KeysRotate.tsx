import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { Footer, type Hint } from "../components/Footer.tsx";
import { fit, pad } from "../lib/text.ts";
import { clearClipboard, readClipboard } from "../lib/keys/win32.ts";
import { readVault, type Vault } from "../lib/keys/vault.ts";
import { cachedDrydock, getDrydock, type DrydockCache } from "../lib/keys/deployed.ts";
import { money } from "../lib/keys/usage/view.ts";
import {
  abandonRotation,
  agoText,
  createMode,
  deadKeys,
  finishRotation,
  planFinish,
  revokeDead,
  runStep,
  setPlan,
  sharedKey,
  sharedKeys,
  startRotation,
  STEP_LABEL,
  stepDone,
  stepsFor,
  type FinishPlan,
  type Member,
  type Plan,
  type SharedKey,
  type StepName,
} from "../lib/keys/rotate.ts";

const ACCENT = T.orange;
const ARM_MS = 4000;
const LOG_KEEP = 40;

interface Props {
  close: () => void;
  /** Open straight on one key (keys rotate --fingerprint). */
  fingerprint?: string;
  /** Open on the dead-key batch revoke (keys rotate --dead). */
  dead?: boolean;
  /** Every step is a dry run; progress lives only in memory (keys rotate --simulate). */
  simulate?: boolean;
}

type View = { kind: "list" } | { kind: "key"; fp: string; tab: "overview" | "walk" } | { kind: "dead" };

interface Line {
  text: string;
  color: string;
}

type Finish = { kind: "plan"; plan: FinishPlan } | { kind: "console"; hint: string; url: string } | null;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function load(): { vault: Vault | null; error: string | null } {
  try {
    return { vault: readVault(), error: null };
  } catch (err) {
    return { vault: null, error: errorText(err) };
  }
}

const usd = (k: SharedKey) => (k.usd7 === null ? "—" : money(k.usd7));

/**
 * The rotate screen (R on Keys): every shared key → one key's overview (who
 * shares it, who's alive, who's deployed, the plan) → the walk, one confirmed
 * step at a time → revoke the old key. Plus the dead-key batch revoke (d).
 */
export function KeysRotate({ close, fingerprint, dead, simulate = false }: Props) {
  const [state, setState] = useState(load);
  const [cache, setCache] = useState<DrydockCache | null>(() => (state.vault ? cachedDrydock(state.vault) : null));
  const [ddError, setDdError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => (dead ? { kind: "dead" } : fingerprint ? { kind: "key", fp: fingerprint, tab: "overview" } : { kind: "list" }));
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState(0);
  const [plans, setPlans] = useState<Record<string, Record<string, Plan>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState<string | null>(null);
  const [log, setLog] = useState<Line[]>([]);
  const [armed, setArmed] = useState<number | null>(null);
  const [awaitClip, setAwaitClip] = useState<{ fp: string; project: string; name: string } | null>(null);
  const [finish, setFinish] = useState<Finish>(null);
  const [override, setOverride] = useState(false);
  // dead mode
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [overridden, setOverridden] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<{ fps: string[]; awaiting: string | null } | null>(null);
  // simulate: progress per fp → project → steps, and which walks "started"/"finished"
  const [sim, setSim] = useState<Record<string, Record<string, StepName[]>>>({});
  const [simStarted, setSimStarted] = useState<Set<string>>(new Set());
  const [frame, setFrame] = useState(0);
  const { width, height } = useTerminalDimensions();

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  const reload = () => setState(load());
  const refreshDrydock = () => {
    const v = readVault();
    getDrydock(v, { refresh: true }).then((r) => {
      if (r.cache) setCache(r.cache);
      setDdError(r.error ?? null);
    });
  };
  useEffect(() => {
    refreshDrydock();
  }, []);

  const now = Date.now();
  if (armed !== null && armed < now) setArmed(null);

  const vault = state.vault;
  const all = useMemo(() => (vault ? sharedKeys(vault, cache) : []), [vault, cache]);
  const deadList = useMemo(() => deadKeys(all), [all]);
  const key = useMemo(() => {
    if (!vault || view.kind !== "key") return null;
    try {
      return sharedKey(vault, cache, view.fp, plans[view.fp] ?? {});
    } catch (err) {
      return errorText(err);
    }
  }, [vault, cache, view, plans]);
  const k = key && typeof key !== "string" ? key : null;

  const say = (text: string, color: string) => setLog((l) => [...l, { text, color }].slice(-LOG_KEEP));

  const work = (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setTick(null);
    fn()
      .catch((err: unknown) => say(`✗ ${errorText(err)}`, T.red))
      .finally(() => {
        setBusy(null);
        setTick(null);
        reload();
      });
  };

  // --- progress (real: the vault's rotation; simulate: memory) -----------------
  const started = k ? (simulate ? simStarted.has(k.fingerprint) : Boolean(k.rotation)) : false;
  const done = (m: Member, s: StepName): boolean => (simulate && k ? (sim[k.fingerprint]?.[m.project] ?? []).includes(s) : stepDone(m.progress, s));
  const memberDone = (m: Member) => m.plan === "cutoff" || stepsFor(m).every((s) => done(m, s));
  const news = k ? k.members.filter((m) => m.plan === "new") : [];
  const doneCount = news.filter(memberDone).length;
  const next = (() => {
    if (!k || !started) return null;
    for (const m of k.members) {
      if (m.plan !== "new") continue;
      const step = stepsFor(m).find((s) => !done(m, s));
      if (step) return { member: m, step };
    }
    return null;
  })();

  // --- rows for the scrolling list --------------------------------------------
  const rowCount = view.kind === "list" ? all.length : view.kind === "dead" ? deadList.length : view.tab === "overview" ? (k?.members.length ?? 0) : 0;
  const sel = Math.min(selected, Math.max(0, rowCount - 1));
  const inner = Math.max(60, width - 6);
  const DETAIL = view.kind === "key" && view.tab === "walk" ? 0 : 5;
  const visRows = Math.max(3, height - 10 - DETAIL);
  const topRow = Math.min(Math.max(Math.min(top, Math.max(0, rowCount - visRows)), sel - visRows + 1), sel);
  useEffect(() => {
    if (topRow !== top) setTop(topRow);
  }, [topRow, top]);

  const open = (fp: string) => {
    setView({ kind: "key", fp, tab: "overview" });
    setSelected(0);
    setFinish(null);
    setAwaitClip(null);
    setOverride(false);
  };

  const togglePlan = (m: Member) => {
    if (!k) return;
    const to: Plan = m.plan === "new" ? "cutoff" : "new";
    if (started && !simulate) {
      if (m.progress?.created && to === "cutoff") return say(`✗ ${m.project} already has its new key — it stays "new key"`, T.red);
      work(`re-planning ${m.project}`, async () => {
        await setPlan(k.fingerprint, m.project, to);
      });
      return;
    }
    if (simulate && started && (sim[k.fingerprint]?.[m.project] ?? []).includes("create")) return say(`✗ ${m.project} already has its new key`, T.red);
    setPlans((p) => ({ ...p, [k.fingerprint]: { ...(p[k.fingerprint] ?? {}), [m.project]: to } }));
  };

  const start = () => {
    if (!k) return;
    if (simulate) {
      setSimStarted((s) => new Set(s).add(k.fingerprint));
      setView({ kind: "key", fp: k.fingerprint, tab: "walk" });
      say(`(simulated) walk started: ${news.length} projects get a new key, ${k.members.length - news.length} get cut off`, T.cyan);
      return;
    }
    work("starting the walk", async () => {
      await startRotation(k.fingerprint, k.members);
      setView({ kind: "key", fp: k.fingerprint, tab: "walk" });
      say(`walk started: ${news.length} projects get a new key, ${k.members.length - news.length} get cut off — saved in the vault, quit any time`, T.cyan);
    });
  };

  const markSim = (fp: string, project: string, step: StepName) =>
    setSim((s) => ({ ...s, [fp]: { ...(s[fp] ?? {}), [project]: [...(s[fp]?.[project] ?? []), step] } }));

  const doStep = () => {
    if (!k || !next) return;
    const { member, step } = next;
    const fp = k.fingerprint;
    const label = `${member.project}: ${STEP_LABEL[step]}`;
    work(label, async () => {
      if (step === "create" && createMode(readVault(), fp, member.project, k.providerId).mode === "console") {
        if (!awaitClip) {
          const r = await runStep(fp, member.project, "create", { dryRun: simulate });
          say(`${simulate ? "(simulated) " : ""}${r.text}`, r.ok ? T.cyan : T.red);
          if (r.ok && r.console) setAwaitClip({ fp, project: member.project, name: r.console.name });
          return;
        }
        setAwaitClip(null);
        if (simulate) {
          markSim(fp, member.project, "create");
          return say(`(simulated) ✓ would read the clipboard, store it as ${member.project}'s key, clear the clipboard`, T.green);
        }
        const value = await readClipboard();
        const r = await runStep(fp, member.project, "create", { clipboard: value });
        await clearClipboard();
        return say(`${r.text} · clipboard cleared`, r.ok ? T.green : T.red);
      }
      const r = await runStep(fp, member.project, step, { dryRun: simulate, apps: member.apps.map((a) => a.name), onTick: setTick });
      if (simulate && r.ok) markSim(fp, member.project, step);
      say(`${simulate ? "(simulated) " : ""}${label} — ${r.text}`, r.ok ? T.green : T.red);
    });
  };

  const doFinish = () => {
    if (!k) return;
    const fp = k.fingerprint;
    if (!finish) {
      work("checking the old key can go", async () => {
        const plan = await planFinish(fp, { cacheOnly: simulate, plans: simulate ? Object.fromEntries(k.members.map((m) => [m.project, m.plan])) : undefined });
        setFinish({ kind: "plan", plan });
      });
      return;
    }
    if (finish.kind === "plan") {
      const ready = simulate ? finish.plan.blockers.filter((b) => !/isn't done/.test(b)).length === 0 : finish.plan.ready;
      if (!ready) return say(`✗ not yet: ${finish.plan.blockers.join("; ")}`, T.red);
      if (finish.plan.soft.length && !override) return say(`⚠ ${finish.plan.soft.join("; ")} — O overrides`, T.yellow);
      if (armed === null) return setArmed(Date.now() + ARM_MS);
      setArmed(null);
      if (simulate) {
        say(`(simulated) ${finish.plan.revoke.note}`, T.green);
        say(`(simulated) would retire ${finish.plan.records} records and drop the .env line in ${finish.plan.cutoff.length ? finish.plan.cutoff.join(", ") : "no cut-off projects"} — rotation finished`, T.green);
        setFinish(null);
        setSimStarted((s) => {
          const n = new Set(s);
          n.delete(fp);
          return n;
        });
        setView({ kind: "list" });
        return;
      }
      work("revoking the old key", async () => {
        const r = await finishRotation(fp, { override });
        say(r.text, r.done ? T.green : T.cyan);
        setFinish(r.console ? { kind: "console", hint: r.console.hint, url: r.console.url } : null);
        if (r.done) setView({ kind: "list" });
      });
      return;
    }
    work("retiring the old key", async () => {
      const r = await finishRotation(fp, { consoleDone: true, override });
      say(r.text, T.green);
      setFinish(null);
      setView({ kind: "list" });
    });
  };

  // --- dead mode ---------------------------------------------------------------
  const runQueue = (fps: string[], consoleDone: boolean) => {
    const [fp, ...rest] = fps;
    if (!fp) {
      setQueue(null);
      setPicked(new Set());
      say("batch revoke finished", T.green);
      return;
    }
    work(`revoking ${fp}`, async () => {
      const r = await revokeDead(fp, { consoleDone, override: overridden.has(fp), dryRun: simulate });
      say(`${simulate ? "(simulated) " : ""}${fp}: ${r.text}`, r.done || simulate ? T.green : T.cyan);
      if (r.console && !simulate) {
        setQueue({ fps, awaiting: fp });
        return;
      }
      setQueue({ fps: rest, awaiting: null });
      setTimeout(() => runQueue(rest, false), 0);
    });
  };

  useKeyboard((ev) => {
    if (ev.ctrl || busy) return;
    const s = ev.sequence;
    const up = ev.name === "up";
    const down = ev.name === "down";
    const clamp = (n: number) => Math.max(0, Math.min(rowCount - 1, n));
    if (up) return setSelected((x) => clamp(Math.min(x, rowCount - 1) - 1));
    if (down) return setSelected((x) => clamp(x + 1));
    if (ev.name === "pageup") return setSelected((x) => clamp(x - visRows));
    if (ev.name === "pagedown") return setSelected((x) => clamp(x + visRows));
    if (s === "D" && view.kind !== "key") return refreshDrydock();

    if (view.kind === "list") {
      if (ev.name === "escape" || s === "q") return close();
      if (ev.name === "return") {
        const hit = all[sel];
        if (hit) open(hit.fingerprint);
        return;
      }
      if (s === "d") {
        setView({ kind: "dead" });
        setSelected(0);
      }
      return;
    }

    if (view.kind === "dead") {
      const row = deadList[sel];
      if (queue?.awaiting) {
        if (ev.name === "return") return runQueue(queue.fps, true);
        if (s === "s") {
          const rest = queue.fps.slice(1);
          say(`skipped ${queue.awaiting} — still active in the vault`, T.yellow);
          return runQueue(rest, false);
        }
        if (ev.name === "escape") {
          setQueue(null);
          return say("batch stopped", T.yellow);
        }
        return;
      }
      if (ev.name === "escape" || s === "q") {
        if (armed !== null) return setArmed(null);
        setView({ kind: "list" });
        return setSelected(0);
      }
      if (!row) return;
      if (s === " " || ev.name === "space") {
        if (row.blockedBy.length && !overridden.has(row.fingerprint)) return say(`⛔ ${row.fingerprint}: ${row.blockedBy.join("; ")} — o overrides`, T.yellow);
        const n = new Set(picked);
        if (n.has(row.fingerprint)) n.delete(row.fingerprint);
        else n.add(row.fingerprint);
        return setPicked(n);
      }
      if (s === "o" && row.blockedBy.length) {
        const n = new Set(overridden);
        if (n.has(row.fingerprint)) n.delete(row.fingerprint);
        else n.add(row.fingerprint);
        return setOverridden(n);
      }
      if (s === "a") return setPicked(new Set(deadList.filter((d) => !d.blockedBy.length || overridden.has(d.fingerprint)).map((d) => d.fingerprint)));
      if (ev.name === "return") {
        if (!picked.size) return say("nothing picked — space picks a key, a picks every clear one", T.yellow);
        if (armed === null) return setArmed(Date.now() + ARM_MS);
        setArmed(null);
        return runQueue([...picked], false);
      }
      return;
    }

    // one key
    if (!k) {
      if (ev.name === "escape" || s === "q") setView({ kind: "list" });
      return;
    }
    if (ev.name === "escape" || s === "q") {
      if (armed !== null) return setArmed(null);
      if (awaitClip) {
        setAwaitClip(null);
        return say("create cancelled — enter starts it again", T.yellow);
      }
      setFinish(null);
      setView({ kind: "list" });
      return setSelected(0);
    }
    if (ev.name === "tab" && started) return setView({ ...view, tab: view.tab === "overview" ? "walk" : "overview" });
    if (s === "O") return setOverride((o) => !o);
    if (view.tab === "overview") {
      const m = k.members[sel];
      if ((s === " " || ev.name === "space") && m) return togglePlan(m);
      if (ev.name === "return") {
        if (!started) {
          if (!news.length) return say("every project is cut off — use the dead-key batch (d on the list) instead", T.yellow);
          if (armed === null) return setArmed(Date.now() + ARM_MS);
          setArmed(null);
          return start();
        }
        return setView({ ...view, tab: "walk" });
      }
      if (s === "X" && started && !simulate) {
        if (armed === null) return setArmed(Date.now() + ARM_MS);
        setArmed(null);
        work("abandoning the walk", async () => {
          await abandonRotation(k.fingerprint);
          say("walk abandoned — keys already made stay; the old key is untouched", T.yellow);
        });
      }
      return;
    }
    // walk
    if (ev.name === "return") return next ? doStep() : doFinish();
  });

  // --- render ------------------------------------------------------------------
  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
  const title =
    view.kind === "list" ? " keys · rotate " : view.kind === "dead" ? " keys · rotate · dead keys " : ` keys · rotate · ${k?.providerId ?? ""} ${view.fp} · ${view.tab} `;
  const lastLog = log[log.length - 1];
  const status: Line = busy
    ? { text: `${spin} ${busy}…${tick ? ` ${tick}` : ""}`, color: T.yellow }
    : armed !== null
      ? { text: armedText(view, k, finish, picked.size, simulate), color: T.red }
      : awaitClip
        ? { text: `copy the new ${k?.provider?.name ?? ""} key named "${awaitClip.name}", then press enter — keys reads the clipboard and clears it · esc cancels`, color: T.cyan }
        : queue?.awaiting
          ? { text: `delete ${queue.awaiting} in the console, then enter · s skips it · esc stops the batch`, color: T.cyan }
          : lastLog && !(view.kind === "key" && view.tab === "walk")
            ? lastLog
            : { text: simulate ? "SIMULATE — every step is a dry run; nothing is minted, written, pushed or revoked" : cacheLine(cache, ddError), color: simulate ? T.yellow : T.dim };

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title={title}
        style={{
          flexGrow: 1,
          flexDirection: "column",
          border: true,
          borderStyle: "rounded",
          borderColor: armed !== null ? T.red : simulate ? T.yellow : T.border,
          titleColor: ACCENT,
          margin: 1,
          marginTop: 0,
          padding: 1,
          paddingTop: 0,
          paddingBottom: 0,
          backgroundColor: T.panel,
        }}
      >
        {view.kind === "list" ? (
          <ListView all={all} sel={sel} topRow={topRow} visRows={visRows} width={inner} onHover={setSelected} simulate={simulate} />
        ) : view.kind === "dead" ? (
          <DeadView rows={deadList} sel={sel} topRow={topRow} visRows={visRows} width={inner} picked={picked} overridden={overridden} onHover={setSelected} />
        ) : !k ? (
          <text fg={T.red}>{pad(`✗ ${typeof key === "string" ? key : "loading"}`, inner)}</text>
        ) : view.tab === "overview" ? (
          <OverviewView k={k} sel={sel} topRow={topRow} visRows={visRows} width={inner} started={started} done={done} doneCount={doneCount} newCount={news.length} onHover={setSelected} />
        ) : (
          <WalkView k={k} width={inner} rows={visRows + 2} done={done} doneCount={doneCount} newCount={news.length} next={next} awaitClip={awaitClip !== null} finish={finish} override={override} log={log} simulate={simulate} />
        )}
        <text fg={status.color}>{pad(status.text, inner)}</text>
      </box>
      <Footer hints={hints(view, started, Boolean(next), queue?.awaiting ?? null, width)} />
    </box>
  );
}

function cacheLine(c: DrydockCache | null, err: string | null): string {
  if (!c) return `Drydock: ${err ?? "loading…"}`;
  const age = Math.round((Date.now() - Date.parse(c.fetchedAt)) / 60_000);
  return `Drydock: ${c.apps.length} apps, ${c.apps.filter((a) => a.folder).length} mapped · read ${age < 1 ? "just now" : `${age}m ago`}${err ? ` · portal down: ${err}` : ""} · 7d $ from the usage cache`;
}

function armedText(view: View, k: SharedKey | null, finish: Finish, picked: number, simulate: boolean): string {
  const sim = simulate ? " (simulated)" : "";
  if (view.kind === "dead") return `⚠ revoke ${picked} dead key${picked === 1 ? "" : "s"} at their providers and retire them everywhere${sim} — enter again`;
  if (view.kind === "key" && view.tab === "walk" && finish?.kind === "plan") return `⚠ revoke the old ${k?.provider?.name ?? ""} key ${k?.fingerprint ?? ""} for good${sim} — enter again`;
  if (view.kind === "key" && view.tab === "overview" && k?.rotation) return `⚠ abandon this walk? keys already made stay; the old key is untouched — X again`;
  return `⚠ start the walk for ${k?.fingerprint ?? ""}${sim}: plans are saved in the vault, every step still asks first — enter again`;
}

function hints(view: View, started: boolean, hasNext: boolean, awaiting: string | null, width: number): Hint[] {
  if (view.kind === "list") return [["↑↓", "select"], ["enter", "open"], ["d", "dead keys"], ["D", "re-read Drydock"], ["esc", "back"]];
  if (view.kind === "dead")
    return awaiting
      ? [["enter", "deleted it"], ["s", "skip"], ["esc", "stop"]]
      : [["↑↓", "select"], ["space", "pick"], ["a", "pick all clear"], ["o", "override block"], ["enter", "revoke picked"], ["esc", "back"]];
  if (view.tab === "overview")
    return [
      ["↑↓", "select"],
      ["space", "new key / cut off"],
      ["enter", started ? "to the walk" : "start the walk"],
      ...(started ? ([["tab", "walk"]] satisfies Hint[]) : []),
      ...(started && width >= 120 ? ([["X", "abandon"]] satisfies Hint[]) : []),
      ["O", "override"],
      ["esc", "back"],
    ];
  return [["enter", hasNext ? "do this step" : "revoke the old key"], ["tab", "overview"], ["O", "override"], ["esc", "pause (resumable)"]];
}

// ─── views ───────────────────────────────────────────────────────────────────

const FP_W = 14;
const PROV_W = 12;
const N_W = 16;
const USD_W = 10;

function ListView({ all, sel, topRow, visRows, width, onHover, simulate }: { all: SharedKey[]; sel: number; topRow: number; visRows: number; width: number; onHover: (i: number) => void; simulate: boolean }) {
  const rotating = all.filter((k) => k.rotation).length;
  const deadN = all.filter((k) => k.dead || k.blockedBy.length).length;
  const left = `${all.length} shared keys${rotating ? ` · ${rotating} rotating` : ""} · ${deadN} dead`;
  const right = simulate ? "SIMULATE · nothing is written" : "one key per project — rotate the hot ones, batch-revoke the dead";
  const stateW = Math.max(10, width - 2 - FP_W - PROV_W - N_W - USD_W - 2);
  const cur = all[sel];
  return (
    <>
      <text>
        <span fg={T.fg}>{left}</span>
        <span fg={simulate ? T.yellow : T.dim}>{fit(right, Math.max(0, width - left.length - 1)).padStart(Math.max(0, width - left.length))}</span>
      </text>
      <text fg={T.dim}>{pad(`  ${pad("fingerprint", FP_W)}${pad("provider", PROV_W)}${pad("projects", N_W)}${"7d $".padStart(USD_W)}  state`, width)}</text>
      <box style={{ flexDirection: "column", height: visRows, width, flexShrink: 0, backgroundColor: T.panel }}>
        {all.length === 0 ? (
          <text fg={T.dim}>{pad("no key is shared between projects — nothing to rotate", width)}</text>
        ) : (
          all.slice(topRow, topRow + visRows).map((k, i) => {
            const idx = topRow + i;
            const isSel = idx === sel;
            const dd = k.members.filter((m) => m.apps.length).length;
            const newN = k.members.filter((m) => m.plan === "new").length;
            const state = k.rotation
              ? `rotating · ${k.members.filter((m) => m.plan === "new" && stepsFor(m).every((s) => stepDone(m.progress, s))).length}/${newN} done`
              : k.dead
                ? "dead — batch revoke (d)"
                : k.blockedBy.length
                  ? "dead? a deployed app's value is unknown"
                  : `${newN} new key · ${k.members.length - newN} cut off`;
            const color = k.rotation ? T.cyan : k.dead || k.blockedBy.length ? T.dim : T.fg;
            return (
              <box key={k.fingerprint} style={{ flexDirection: "row", height: 1, width, backgroundColor: isSel ? T.selectionBg : T.panel }} onMouseOver={() => onHover(idx)}>
                <text>
                  <span fg={isSel ? ACCENT : T.dim}>{isSel ? "❯ " : "  "}</span>
                  <span fg={isSel ? T.cyan : T.dim}>{pad(k.fingerprint, FP_W)}</span>
                  <span fg={T.fg}>{pad(k.providerId, PROV_W)}</span>
                  <span fg={k.members.length >= 5 ? T.red : T.fg}>{pad(`${k.members.length}${dd ? ` · ${dd} [dd]` : ""}`, N_W)}</span>
                  <span fg={(k.usd7 ?? 0) >= 1 ? T.yellow : T.dim}>{usd(k).padStart(USD_W)}</span>
                  <span>{"  "}</span>
                  <span fg={color}>{pad(state, stateW)}</span>
                </text>
              </box>
            );
          })
        )}
      </box>
      <DetailBlock
        width={width}
        lines={
          cur
            ? [
                { text: `${cur.provider?.name ?? cur.providerId} key fp ${cur.fingerprint} · ${usd(cur)} in 7d`, color: T.fg },
                { text: cur.members.map((m) => `${m.project}${m.apps.length ? " [dd]" : ""}`).join(", "), color: T.dim },
                ...(cur.strays.length ? [{ text: `⚠ also on Drydock without a mapped folder: ${cur.strays.map((s) => s.app.name).join(", ")}`, color: T.yellow }] : []),
                ...(cur.blockedBy.length ? [{ text: `⛔ ${cur.blockedBy.join("; ")}`, color: T.yellow }] : []),
              ]
            : []
        }
      />
    </>
  );
}

const PROJ_W = 24;
const ACT_W = 16;
const DD_W = 24;
const PLAN_W = 10;
const STEPS_W = 10;

function stepMarks(m: Member, done: (m: Member, s: StepName) => boolean, failed: boolean): string {
  if (m.plan === "cutoff") return "—";
  const steps = stepsFor(m);
  const first = steps.findIndex((s) => !done(m, s));
  return steps.map((s, i) => (done(m, s) ? "✓" : i === first && failed ? "✗" : "·")).join(" ");
}

function OverviewView({
  k,
  sel,
  topRow,
  visRows,
  width,
  started,
  done,
  doneCount,
  newCount,
  onHover,
}: {
  k: SharedKey;
  sel: number;
  topRow: number;
  visRows: number;
  width: number;
  started: boolean;
  done: (m: Member, s: StepName) => boolean;
  doneCount: number;
  newCount: number;
  onHover: (i: number) => void;
}) {
  const cut = k.members.length - newCount;
  const left = `${k.provider?.name ?? k.providerId} · shared by ${k.members.length} · ${usd(k)} in 7d · ${newCount} new key · ${cut} cut off`;
  const right = started ? `${doneCount}/${newCount} done` : "not started";
  const noteW = Math.max(6, width - 2 - PROJ_W - ACT_W - DD_W - PLAN_W - STEPS_W);
  const cur = k.members[sel];
  return (
    <>
      <text>
        <span fg={T.fg}>{fit(left, width - right.length - 1)}</span>
        <span fg={started ? T.cyan : T.dim}>{right.padStart(Math.max(0, width - Math.min(left.length, width - right.length - 1)))}</span>
      </text>
      <text fg={T.dim}>{pad(`  ${pad("project", PROJ_W)}${pad("last activity", ACT_W)}${pad("drydock", DD_W)}${pad("plan", PLAN_W)}${pad("steps", STEPS_W)}why`, width)}</text>
      <box style={{ flexDirection: "column", height: visRows, width, flexShrink: 0, backgroundColor: T.panel }}>
        {k.members.slice(topRow, topRow + visRows).map((m, i) => {
          const idx = topRow + i;
          const isSel = idx === sel;
          const act = m.activity.lastAt === null ? "none" : `${agoText(m.activity.lastAt)} ${m.activity.source === "git" ? "git" : "claude"}`;
          const dd = m.apps.length ? m.apps.map((a) => `${a.name}${a.how === "uses" ? " ●" : a.how === "maybe" ? " ?" : " ○"}`).join(" ") : "—";
          const failed = Boolean(m.progress?.error);
          return (
            <box key={m.project} style={{ flexDirection: "row", height: 1, width, backgroundColor: isSel ? T.selectionBg : T.panel }} onMouseOver={() => onHover(idx)}>
              <text>
                <span fg={isSel ? ACCENT : T.dim}>{isSel ? "❯ " : "  "}</span>
                <span fg={T.fg}>{pad(m.project, PROJ_W)}</span>
                <span fg={m.activity.active ? T.green : T.dim}>{pad(act, ACT_W)}</span>
                <span fg={m.apps.some((a) => a.how === "uses") ? T.purple : T.dim}>{pad(dd, DD_W)}</span>
                <span fg={m.plan === "new" ? T.green : T.red}>{pad(`${m.plan === "new" ? "new key" : "cut off"}${m.plan !== m.defaultPlan ? "*" : ""}`, PLAN_W)}</span>
                <span fg={failed ? T.red : T.cyan}>{pad(stepMarks(m, done, failed), STEPS_W)}</span>
                <span fg={T.dim}>{pad(m.why, noteW)}</span>
              </text>
            </box>
          );
        })}
      </box>
      <DetailBlock
        width={width}
        lines={[
          ...(cur
            ? [
                {
                  text: `${cur.project}: ${cur.plan === "new" ? `gets its own key (${stepsFor(cur).map((s) => STEP_LABEL[s]).join(" → ")})` : "cut off — its .env line goes when the old key is revoked"}${cur.plan !== cur.defaultPlan ? ` · default was ${cur.defaultPlan === "new" ? "new key" : "cut off"}` : ""}`,
                  color: T.fg,
                },
                ...(cur.progress?.error ? [{ text: `✗ last try: ${cur.progress.error}`, color: T.red }] : []),
              ]
            : []),
          { text: "drydock: ● holds this key · ? var present, value unknown · ○ deployed on a different key", color: T.dim },
          ...(k.strays.length ? [{ text: `⚠ deployed without a mapped folder: ${k.strays.map((s) => `${s.app.name} (${s.how})`).join(", ")} — blocks the revoke until mapped`, color: T.yellow }] : []),
        ]}
      />
    </>
  );
}

function WalkView({
  k,
  width,
  rows,
  done,
  doneCount,
  newCount,
  next,
  awaitClip,
  finish,
  override,
  log,
  simulate,
}: {
  k: SharedKey;
  width: number;
  rows: number;
  done: (m: Member, s: StepName) => boolean;
  doneCount: number;
  newCount: number;
  next: { member: Member; step: StepName } | null;
  awaitClip: boolean;
  finish: Finish;
  override: boolean;
  log: Line[];
  simulate: boolean;
}) {
  const lines: Line[] = [];
  const barW = Math.max(10, Math.min(40, width - 30));
  const filled = newCount ? Math.round((doneCount / newCount) * barW) : 0;
  lines.push({ text: `${"█".repeat(filled)}${"░".repeat(barW - filled)}  ${doneCount}/${newCount} done${simulate ? " · SIMULATE" : ""}`, color: doneCount === newCount ? T.green : T.cyan });
  lines.push({ text: "", color: T.dim });
  if (next) {
    const m = next.member;
    const idx = k.members.filter((x) => x.plan === "new").indexOf(m) + 1;
    lines.push({ text: `${idx}/${newCount} ${m.project}${m.apps.length ? `  [dd] ${m.apps.map((a) => a.name).join(", ")}` : ""}  · ${m.why}`, color: T.fg });
    for (const s of stepsFor(m)) {
      const isNext = s === next.step;
      const mark = done(m, s) ? "✓" : isNext ? "❯" : "·";
      const note = done(m, s) ? stepNote(m, s) : isNext ? nextText(k, m, s, awaitClip) : "";
      lines.push({ text: `   ${mark} ${pad(STEP_LABEL[s], 9)}${note}`, color: done(m, s) ? T.green : isNext ? ACCENT : T.dim });
    }
    if (m.progress?.error) lines.push({ text: `   ✗ last try: ${m.progress.error}`, color: T.red });
    const queued = k.members.filter((x) => x.plan === "new" && x !== m && !stepsFor(x).every((s) => done(x, s)));
    lines.push({ text: "", color: T.dim });
    lines.push({ text: `up next: ${queued.slice(0, 8).map((x) => x.project).join(", ")}${queued.length > 8 ? ` +${queued.length - 8}` : ""}${queued.length ? "" : "nothing — this is the last one"}`, color: T.dim });
  } else {
    lines.push({ text: `every new-key project is done and verified`, color: T.green });
    if (!finish) lines.push({ text: `enter checks that nothing deployed still holds the old key, then offers to revoke it`, color: T.fg });
    else if (finish.kind === "plan") {
      const p = finish.plan;
      const hard = simulate ? p.blockers.filter((b) => !/isn't done/.test(b)) : p.blockers;
      for (const b of hard) lines.push({ text: `⛔ ${b}`, color: T.red });
      for (const b of p.soft) lines.push({ text: `⚠ ${b}${override ? " — overridden" : " — O to override"}`, color: T.yellow });
      lines.push({ text: `old key: ${p.revoke.note}`, color: hard.length ? T.dim : T.fg });
      lines.push({ text: `then ${p.records} vault records are retired; .env lines removed in ${p.cutoff.length ? p.cutoff.join(", ") : "no cut-off projects"}`, color: T.dim });
      if (!hard.length && (!p.soft.length || override)) lines.push({ text: "enter (twice) revokes it", color: ACCENT });
    } else lines.push({ text: `delete the key ${finish.hint} at ${finish.url}, then enter`, color: T.cyan });
  }
  lines.push({ text: "", color: T.dim });
  const room = Math.max(0, rows - lines.length);
  const tail = log.slice(-room);
  for (const l of tail) lines.push(l);
  while (lines.length < rows) lines.push({ text: "", color: T.dim });
  return (
    <box style={{ flexDirection: "column", height: rows, width, flexShrink: 0, backgroundColor: T.panel }}>
      {lines.slice(0, rows).map((l, i) => (
        <text key={`w${i}`} fg={l.color}>
          {pad(l.text, width)}
        </text>
      ))}
    </box>
  );
}

function stepNote(m: Member, s: StepName): string {
  const p = m.progress;
  const n = s === "create" ? p?.created?.note : s === "env" ? p?.env?.note : s === "push" ? p?.pushed?.note : p?.verified?.note;
  return n ?? "done";
}

function nextText(k: SharedKey, m: Member, s: StepName, awaitClip: boolean): string {
  const name = k.provider?.name ?? k.providerId;
  if (s === "create") {
    const mode = createMode(readVault(), k.fingerprint, m.project, k.providerId);
    if (mode.mode === "own") return `enter: use ${m.project}'s own ${name} key ${mode.ownKey?.id ?? ""}`;
    if (mode.mode === "mint") return `enter: mint a new ${name} key "keys-${m.project}"`;
    return awaitClip ? `copy the new key, then enter (reads + clears the clipboard)` : `enter: open the ${name} console to make "keys-${m.project}" · ${mode.why ?? "console only"}`;
  }
  if (s === "env") return `enter: write the new key into ${m.project}'s .env`;
  if (s === "push") return `enter: set it on ${m.apps.map((a) => a.name).join(", ")}, Apply + redeploy, wait for the deploy`;
  return `enter: call ${name} with the new key — OK or FAIL`;
}

function DeadView({
  rows,
  sel,
  topRow,
  visRows,
  width,
  picked,
  overridden,
  onHover,
}: {
  rows: SharedKey[];
  sel: number;
  topRow: number;
  visRows: number;
  width: number;
  picked: Set<string>;
  overridden: Set<string>;
  onHover: (i: number) => void;
}) {
  const clear = rows.filter((r) => !r.blockedBy.length).length;
  const left = `${rows.length} dead shared keys · ${clear} clear · ${rows.length - clear} blocked · ${picked.size} picked`;
  const projW = Math.max(10, width - 2 - 4 - FP_W - PROV_W - 4 - USD_W - 2);
  const cur = rows[sel];
  return (
    <>
      <text fg={T.fg}>{pad(left, width)}</text>
      <text fg={T.dim}>{pad(`      ${pad("fingerprint", FP_W)}${pad("provider", PROV_W)}${pad("n", 4)}${"7d $".padStart(USD_W)}  projects (none active in 30d, none deployed on it)`, width)}</text>
      <box style={{ flexDirection: "column", height: visRows, width, flexShrink: 0, backgroundColor: T.panel }}>
        {rows.length === 0 ? (
          <text fg={T.dim}>{pad("no dead shared keys — every shared key has an active or deployed project", width)}</text>
        ) : (
          rows.slice(topRow, topRow + visRows).map((k, i) => {
            const idx = topRow + i;
            const isSel = idx === sel;
            const blocked = k.blockedBy.length > 0 && !overridden.has(k.fingerprint);
            const box = picked.has(k.fingerprint) ? "[x]" : blocked ? "[⛔]" : "[ ]";
            return (
              <box key={k.fingerprint} style={{ flexDirection: "row", height: 1, width, backgroundColor: isSel ? T.selectionBg : T.panel }} onMouseOver={() => onHover(idx)}>
                <text>
                  <span fg={isSel ? ACCENT : T.dim}>{isSel ? "❯ " : "  "}</span>
                  <span fg={picked.has(k.fingerprint) ? T.red : blocked ? T.yellow : T.dim}>{pad(box, 4)}</span>
                  <span fg={isSel ? T.cyan : T.dim}>{pad(k.fingerprint, FP_W)}</span>
                  <span fg={T.fg}>{pad(k.providerId, PROV_W)}</span>
                  <span fg={T.fg}>{pad(String(k.members.length), 4)}</span>
                  <span fg={T.dim}>{usd(k).padStart(USD_W)}</span>
                  <span>{"  "}</span>
                  <span fg={T.dim}>{pad(k.members.map((m) => `${m.project} (${agoText(m.activity.lastAt)})`).join(", "), projW)}</span>
                </text>
              </box>
            );
          })
        )}
      </box>
      <DetailBlock
        width={width}
        lines={
          cur
            ? [
                { text: `${cur.provider?.name ?? cur.providerId} fp ${cur.fingerprint}: revoked at the provider where an adapter + admin key exist; otherwise the console opens with which key to delete`, color: T.fg },
                ...(cur.blockedBy.length ? [{ text: `⛔ ${cur.blockedBy.join("; ")}${overridden.has(cur.fingerprint) ? " — overridden" : " — o overrides"}`, color: T.yellow }] : []),
              ]
            : []
        }
      />
    </>
  );
}

function DetailBlock({ lines, width }: { lines: Line[]; width: number }) {
  const rows = lines.slice(0, 5);
  while (rows.length < 5) rows.push({ text: "", color: T.dim });
  return (
    <box style={{ flexDirection: "column", height: 5, width, flexShrink: 0, backgroundColor: T.panel }}>
      {rows.map((r, i) => (
        <text key={`d${i}`} fg={r.color}>
          {pad(r.text, width)}
        </text>
      ))}
    </box>
  );
}
