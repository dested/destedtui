import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { Footer } from "../components/Footer.tsx";
import { fit, pad } from "../lib/text.ts";
import { openInChrome } from "../lib/run.ts";
import { clearClipboard, readClipboard } from "../lib/keys/win32.ts";
import { readVault, reuseGroups, type Provider, type Vault } from "../lib/keys/vault.ts";
import {
  addKey,
  addProvider,
  importKeys,
  mintAbility,
  newKey,
  projectFromCwd,
  revokeKey,
  setAdmin,
  viewKeys,
  writeEnv,
  type KeyView,
} from "../lib/keys/ops.ts";

const ACCENT = T.orange;
const ARM_MS = 3000;
const FLASH_MS = 6000;

type Group = "project" | "provider";

interface Props {
  cwd: string;
  back: () => void;
}

interface Flash {
  text: string;
  color: string;
  until: number;
}

type Row = { kind: "header"; key: string; title: string; sub: string } | { kind: "key"; key: string; k: KeyView };

// ─── forms (they replace the list; never an overlay — ui.md) ─────────────────

type FormKind = "new" | "add" | "provider" | "admin";

interface Field {
  name: string;
  label: string;
  value: string;
  /** Present = a choice field cycled with ←/→ instead of typed. */
  options?: string[];
}

interface Form {
  kind: FormKind;
  fields: Field[];
  focus: number;
  error: string | null;
}

const FORM_TITLES: Record<FormKind, string> = {
  new: " new key ",
  add: " add key from clipboard ",
  provider: " add provider ",
  admin: " admin credential from clipboard ",
};

const FORM_HINTS: Record<FormKind, string> = {
  new: "mints when the provider allows it; otherwise opens its console",
  add: "copy the key first — enter reads the clipboard, then clears it",
  provider: "console-only; it shows up in new/add right away",
  admin: "copy the admin key first — meta is optional (k=v k=v)",
};

function field(form: Form, name: string): string {
  return form.fields.find((f) => f.name === name)?.value.trim() ?? "";
}

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

export function Keys({ cwd, back }: Props) {
  // Read during the first render (DPAPI decrypt is ~1ms) — an empty first frame paints torn rows.
  const [state, setState] = useState(load);
  const [group, setGroup] = useState<Group>("project");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [top, setTop] = useState(0);
  const [armed, setArmed] = useState<{ id: string; until: number } | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const lastIndex = useRef(0);
  const { width, height } = useTerminalDimensions();
  const here = useMemo(() => projectFromCwd(cwd), [cwd]);

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  if (armed && armed.until < now) setArmed(null);
  if (flash && flash.until < now) setFlash(null);

  const vault = state.vault;
  const keys = useMemo(() => (vault ? viewKeys(vault) : []), [vault]);
  const providers = vault?.providers ?? [];
  const shared = useMemo(() => (vault ? reuseGroups(vault) : []), [vault]);

  const rows = useMemo<Row[]>(() => {
    const sorted = [...keys].sort((a, b) =>
      group === "project"
        ? a.project.localeCompare(b.project) || a.providerId.localeCompare(b.providerId)
        : a.providerId.localeCompare(b.providerId) || a.project.localeCompare(b.project),
    );
    const out: Row[] = [];
    let last = "";
    for (const k of sorted) {
      const g = group === "project" ? k.project : k.providerId;
      if (g !== last) {
        last = g;
        const p = providers.find((x) => x.id === g);
        const sub =
          group === "provider" && p && vault
            ? { mint: "mints", "no-admin": "can mint · needs admin", "console-only": "console only" }[mintAbility(vault, p)]
            : g === here
              ? "you are here"
              : "";
        out.push({ kind: "header", key: `h:${g}`, title: group === "provider" ? (p?.name ?? g) : g, sub });
      }
      out.push({ kind: "key", key: k.id, k });
    }
    return out;
  }, [keys, group, providers, vault, here]);

  const keyRows = rows.flatMap((r, i) => (r.kind === "key" ? [{ i, k: r.k }] : []));
  const found = selectedId === null ? -1 : keyRows.findIndex((r) => r.k.id === selectedId);
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, keyRows.length - 1));
  lastIndex.current = index;
  const current = keyRows[index]?.k ?? null;
  const currentRow = keyRows[index]?.i ?? 0;

  // --- geometry: explicit everywhere (ui.md, Painting) ------------------------
  const inner = Math.max(40, width - 6); // margin 2 + border 2 + padding 2
  // header 3 + panel border 2 + summary + column header + status + bottom margin 1 + footer 1
  const visRows = Math.max(3, height - 10);
  const maxTop = Math.max(0, rows.length - visRows);
  const topRow = Math.min(Math.max(Math.min(top, maxTop), currentRow - visRows + 1), currentRow);
  const windowRows = rows.slice(topRow, topRow + visRows);

  useEffect(() => {
    if (topRow !== top) setTop(topRow);
  }, [topRow, top]);

  const select = (i: number) => {
    const r = keyRows[Math.min(Math.max(0, i), keyRows.length - 1)];
    if (r) setSelectedId(r.k.id);
  };

  const say = (text: string, color: string) => setFlash({ text, color, until: Date.now() + FLASH_MS });
  const reload = () => setState(load());

  /** One async op at a time; the spinner owns the status line while it runs. */
  const work = (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    fn()
      .then((msg) => say(msg, T.green))
      .catch((err: unknown) => say(`✗ ${errorText(err)}`, T.red))
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  const providerIds = providers.map((p) => p.id);
  const defaultProvider = current?.providerId ?? providerIds[0] ?? "";
  const defaultProject = (group === "project" ? current?.project : undefined) ?? here ?? current?.project ?? "";

  const openForm = (kind: FormKind, seed: { provider?: string; project?: string } = {}) => {
    const provider = seed.provider ?? defaultProvider;
    const project = seed.project ?? defaultProject;
    const fields: Record<FormKind, Field[]> = {
      new: [
        { name: "provider", label: "provider", value: provider, options: providerIds },
        { name: "project", label: "project", value: project },
        { name: "label", label: "label", value: "" },
        { name: "replace", label: "replace", value: "no", options: ["no", "yes"] },
      ],
      add: [
        { name: "provider", label: "provider", value: provider, options: providerIds },
        { name: "project", label: "project", value: project },
        { name: "label", label: "label", value: "" },
        { name: "replace", label: "replace", value: "no", options: ["no", "yes"] },
      ],
      provider: [
        { name: "id", label: "id", value: "" },
        { name: "name", label: "name", value: "" },
        { name: "envVar", label: "env var", value: "" },
        { name: "consoleUrl", label: "console", value: "" },
      ],
      admin: [
        { name: "provider", label: "provider", value: provider, options: providerIds },
        { name: "meta", label: "meta", value: "" },
      ],
    };
    setForm({ kind, fields: fields[kind], focus: kind === "provider" ? 0 : 1, error: null });
  };

  const submit = (f: Form) => {
    const provider = field(f, "provider");
    const project = field(f, "project");
    const label = field(f, "label") || undefined;
    const replace = field(f, "replace") === "yes";
    if ((f.kind === "new" || f.kind === "add") && !project) return setForm({ ...f, error: "which project?" });
    setForm(null);
    if (f.kind === "new") {
      work(`minting ${provider} key for ${project}`, async () => {
        const res = await newKey({ provider, project, label, replace });
        if (res.kind === "minted") return `✓ minted ${res.key.id} for ${res.key.project} · fp ${res.key.fingerprint} · written to ${res.key.envFile}`;
        const why = res.reason === "no-admin" ? "no admin credential yet (m sets one)" : "no key API";
        return `↗ ${res.provider.name}: ${why} — opened the console. Make a key named "${project}", copy it, press a`;
      });
    } else if (f.kind === "add") {
      work(`storing ${provider} key for ${project}`, async () => {
        const res = await addKey({ provider, project, label, replace }, await readClipboard());
        await clearClipboard();
        return `✓ stored ${res.key.id} for ${res.key.project} · fp ${res.key.fingerprint} · clipboard cleared`;
      });
    } else if (f.kind === "provider") {
      work("adding provider", async () => {
        const p = await addProvider({ id: field(f, "id"), name: field(f, "name") || field(f, "id"), envVar: field(f, "envVar"), consoleUrl: field(f, "consoleUrl") });
        return `✓ added provider ${p.id} (${p.envVar})`;
      });
    } else {
      work(`storing ${provider} admin credential`, async () => {
        const meta: Record<string, string> = {};
        for (const kv of field(f, "meta").split(/\s+/).filter(Boolean)) {
          const i = kv.indexOf("=");
          if (i > 0) meta[kv.slice(0, i)] = kv.slice(i + 1);
        }
        const res = await setAdmin(provider, await readClipboard(), meta);
        await clearClipboard();
        return `✓ ${provider} admin credential stored · fp ${res.fingerprint} · clipboard cleared`;
      });
    }
  };

  const revoke = (k: KeyView | null) => {
    if (!k) return;
    if (!armed || armed.id !== k.id) return setArmed({ id: k.id, until: Date.now() + ARM_MS });
    setArmed(null);
    work(`revoking ${k.id}`, async () => {
      const res = await revokeKey(k.id);
      return `✓ revoked ${res.id} (${res.project}) — ${res.remoteNote}${res.envRemoved ? " · .env line removed" : ""}`;
    });
  };

  const writeDotEnv = (k: KeyView | null) => {
    if (!k) return;
    if (k.project === "shared") return say("✗ shared keys have no project folder to write into", T.red);
    work(`writing ${k.project}/.env`, async () => {
      const res = await writeEnv(k.project, false);
      const changed = res.plans.flatMap((p) => p.changes.filter((c) => c.change !== "same").map((c) => `${c.change} ${c.envVar}`));
      const tracked = res.ignore.some((i) => i.tracked) ? " · ⚠ that .env is COMMITTED to git" : "";
      return `${changed.length ? `✓ ${res.project}: ${changed.join(", ")}` : `✓ ${res.project}: .env already up to date`}${tracked}`;
    });
  };

  const openConsole = (k: KeyView | null) => {
    const p = providers.find((x) => x.id === (k?.providerId ?? defaultProvider));
    if (!p) return;
    openInChrome(p.consoleUrl);
    say(`↗ opened ${p.consoleUrl}`, T.cyan);
  };

  useKeyboard((key) => {
    if (key.ctrl || busy) return;

    if (form) {
      const f = form;
      const fieldNow = f.fields[f.focus];
      if (!fieldNow) return;
      const setField = (fn: (v: string) => string) =>
        setForm((cur) => (cur ? { ...cur, error: null, fields: cur.fields.map((x, i) => (i === cur.focus ? { ...x, value: fn(x.value) } : x)) } : cur));
      if (key.name === "escape") return setForm(null);
      if (key.name === "return") return submit(f);
      if (key.name === "tab" || key.name === "down") return setForm({ ...f, focus: (f.focus + (key.shift ? f.fields.length - 1 : 1)) % f.fields.length });
      if (key.name === "up") return setForm({ ...f, focus: (f.focus + f.fields.length - 1) % f.fields.length });
      if (fieldNow.options) {
        const opts = fieldNow.options;
        if (key.name === "left" || key.name === "right" || key.name === "space") {
          const step = key.name === "left" ? -1 : 1;
          return setField((v) => opts[(opts.indexOf(v) + step + opts.length) % opts.length] ?? v);
        }
        // Typing on a choice field jumps to the first option starting with that letter.
        const ch = key.sequence;
        if (ch && ch.length === 1 && ch > " ") {
          const hit = opts.find((o) => o.startsWith(ch.toLowerCase()));
          if (hit) setField(() => hit);
        }
        return;
      }
      if (key.name === "backspace") return setField((v) => v.slice(0, -1));
      const ch = key.sequence;
      if (ch && ch.length === 1 && ch >= " ") setField((v) => v + ch);
      return;
    }

    if (key.name === "escape") {
      if (armed) return setArmed(null);
      return back();
    }
    if (key.name === "up") return select(index - 1);
    if (key.name === "down") return select(index + 1);
    if (key.name === "pageup") return select(index - visRows);
    if (key.name === "pagedown") return select(index + visRows);
    if (key.name === "home") return select(0);
    if (key.name === "end") return select(keyRows.length - 1);
    switch (key.sequence) {
      case "q":
        return back();
      case "n":
        return openForm("new");
      case "a":
        return openForm("add");
      case "p":
        return openForm("provider");
      case "m":
        return openForm("admin");
      case "x":
        return revoke(current);
      case "w":
        return writeDotEnv(current);
      case "o":
        return openConsole(current);
      case "g":
        return setGroup((g) => (g === "project" ? "provider" : "project"));
      case "i":
        return work("scanning every project's .env", async () => {
          const r = await importKeys();
          return `✓ scanned ${r.filesScanned} env files · ${r.imported.length} imported · ${r.known} known · ${r.conflicts.length} conflicts · ${r.reuse.length} shared`;
        });
    }
  });

  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
  const projectsCount = new Set(keys.map((k) => k.project)).size;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" keys "
        style={{
          flexGrow: 1,
          flexDirection: "column",
          border: true,
          borderStyle: "rounded",
          borderColor: armed ? T.red : state.error ? T.red : T.border,
          titleColor: ACCENT,
          margin: 1,
          marginTop: 0,
          padding: 1,
          paddingTop: 0,
          paddingBottom: 0,
          backgroundColor: T.panel,
        }}
      >
        <Summary width={inner} keys={keys.length} projects={projectsCount} shared={shared.length} group={group} />
        <text fg={T.dim}>{columnHeader(inner, group)}</text>
        <box style={{ flexDirection: "column", height: visRows, width: inner, flexShrink: 0, backgroundColor: T.panel }}>
          {form ? (
            <FormPanel form={form} width={inner} height={visRows} />
          ) : state.error ? (
            <text fg={T.red}>{pad(`✗ ${state.error}`, inner)}</text>
          ) : rows.length === 0 ? (
            <box style={{ flexDirection: "column", width: inner }}>
              <text fg={T.dim}>{pad("No keys yet — i imports every key already sitting in a project .env; n makes a new one.", inner)}</text>
            </box>
          ) : (
            windowRows.map((row) =>
              row.kind === "header" ? (
                <GroupHeader key={row.key} title={row.title} sub={row.sub} width={inner} />
              ) : (
                <KeyRow
                  key={row.key}
                  k={row.k}
                  width={inner}
                  group={group}
                  selected={row.k.id === current?.id}
                  armed={armed?.id === row.k.id}
                  onHover={() => setSelectedId(row.k.id)}
                  onEnv={() => {
                    setSelectedId(row.k.id);
                    writeDotEnv(row.k);
                  }}
                  onConsole={() => openConsole(row.k)}
                  onRevoke={() => {
                    setSelectedId(row.k.id);
                    revoke(row.k);
                  }}
                />
              ),
            )
          )}
        </box>
        <StatusLine
          width={inner}
          busy={busy}
          spin={spin}
          flash={flash}
          armed={armed && current?.id === armed.id ? current : null}
          vault={vault}
          rows={rows.length}
          topRow={topRow}
          visRows={visRows}
        />
      </box>
      <Footer
        hints={
          form
            ? [
                ["type", "edit"],
                ["tab/↑↓", "field"],
                ["←→", "choose"],
                ["enter", form.kind === "add" || form.kind === "admin" ? "read clipboard" : "go"],
                ["esc", "cancel"],
              ]
            : width >= 140
              ? [
                  ["↑↓", "select"],
                  ["n", "new / mint"],
                  ["a", "add from clipboard"],
                  ["w", "write .env"],
                  ["o", "console"],
                  ["x", "revoke"],
                  ["g", group === "project" ? "by provider" : "by project"],
                  ["i", "import"],
                  ["p", "provider"],
                  ["m", "admin"],
                  ["esc", "back"],
                ]
              : [
                  ["n", "new"],
                  ["a", "add"],
                  ["w", ".env"],
                  ["o", "console"],
                  ["x", "revoke"],
                  ["g", "group"],
                  ["i", "import"],
                  ["esc", "back"],
                ]
        }
      />
    </box>
  );
}

// ─── pieces ──────────────────────────────────────────────────────────────────

const WHO_W = 14; // provider (by project) or project (by provider)
const ID_W = 12;
const FP_W = 14;
const SRC_W = 9;
const BTN_W = 15; // " " + [ .env ] + " " + [ ↗ ] + " " + [ ✕? ]

/** The reuse warning, shortened to fit the column on a narrow terminal. */
function shareText(k: KeyView, room: number): string {
  if (!k.sharedWith.length) return "";
  const n = k.sharedWith.length + 1;
  const long = `⚠ same key in ${n} projects`;
  return long.length < room ? long : `⚠ ${n} projects`;
}

function fileWidth(width: number): number {
  const fixed = 4 + WHO_W + ID_W + FP_W + SRC_W + BTN_W;
  // Reuse column: 26 cells when there's room, never below 13 ("⚠ 24 projects").
  return Math.max(8, width - fixed - Math.max(13, Math.min(26, width - fixed - 30)));
}

function columnHeader(width: number, group: Group): string {
  return pad(`    ${pad(group === "project" ? "provider" : "project", WHO_W)}${pad("id", ID_W)}${pad("fingerprint", FP_W)}${pad("source", SRC_W)}${pad("file", fileWidth(width))}`, width);
}

function Summary({ width, keys, projects, shared, group }: { width: number; keys: number; projects: number; shared: number; group: Group }) {
  const left = `${keys} key${keys === 1 ? "" : "s"} · ${projects} project${projects === 1 ? "" : "s"}`;
  const warn = shared ? ` · ⚠ ${shared} shared between projects` : "";
  const right = `by ${group} · values never shown`;
  const gap = Math.max(1, width - left.length - warn.length - right.length);
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <text>
        <span fg={T.fg}>{left}</span>
        <span fg={T.red}>{warn}</span>
        <span>{" ".repeat(gap)}</span>
        <span fg={T.dim}>{fit(right, Math.max(0, width - left.length - warn.length - 1))}</span>
      </text>
    </box>
  );
}

function GroupHeader({ title, sub, width }: { title: string; sub: string; width: number }) {
  return (
    <box style={{ height: 1, width, backgroundColor: T.panel }}>
      <text>
        <span fg={ACCENT}>{"◆ "}</span>
        <span fg={T.fg}>{title}</span>
        <span fg={T.dim}>{pad(sub ? `  ${sub}` : "", Math.max(0, width - title.length - 2))}</span>
      </text>
    </box>
  );
}

function KeyRow({
  k,
  width,
  group,
  selected,
  armed,
  onHover,
  onEnv,
  onConsole,
  onRevoke,
}: {
  k: KeyView;
  width: number;
  group: Group;
  selected: boolean;
  armed: boolean;
  onHover: () => void;
  onEnv: () => void;
  onConsole: () => void;
  onRevoke: () => void;
}) {
  const who = group === "project" ? k.providerId : k.project;
  const fw = fileWidth(width);
  const share = shareText(k, width - BTN_W - 4 - WHO_W - ID_W - FP_W - SRC_W - fw);
  const file = k.envFile === ".env" ? `.env ${k.envVar}` : `${k.envFile} ${k.envVar}`;
  const rest = width - BTN_W - 4 - WHO_W - ID_W - FP_W - SRC_W - fw;
  const bg = armed ? T.surface : selected ? T.selectionBg : T.panel;
  return (
    <box style={{ flexDirection: "row", height: 1, width, backgroundColor: bg }} onMouseOver={onHover}>
      <text>
        <span fg={selected ? ACCENT : T.dim}>{selected ? "❯ " : "  "}</span>
        <span fg={T.dim}>{"  "}</span>
        <span fg={armed ? T.red : selected ? T.fg : T.fg}>{pad(who, WHO_W)}</span>
        <span fg={T.dim}>{pad(k.id, ID_W)}</span>
        <span fg={selected ? T.cyan : T.dim}>{pad(k.fingerprint, FP_W)}</span>
        <span fg={k.source === "minted" ? T.green : T.dim}>{pad(k.source, SRC_W)}</span>
        <span fg={T.dim}>{pad(file, fw)}</span>
        <span fg={T.red}>{pad(share, Math.max(0, rest))}</span>
      </text>
      <RowButton label=".env" color={T.green} width={6} onPress={onEnv} />
      <box style={{ width: 1, height: 1 }} />
      <RowButton label="↗" color={T.cyan} width={3} onPress={onConsole} />
      <box style={{ width: 1, height: 1 }} />
      <RowButton label={armed ? "✕?" : "✕"} color={T.red} width={4} hot={armed} onPress={onRevoke} />
    </box>
  );
}

/** Fixed-width button — the armed label is wider, and a box that resizes leaves paint behind. */
function RowButton({ label, color, width, hot = false, onPress }: { label: string; color: string; width: number; hot?: boolean; onPress: () => void }) {
  return (
    <box
      style={{ width, height: 1, flexShrink: 0, backgroundColor: hot ? T.red : T.surfaceAlt }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onPress();
      }}
    >
      <text fg={hot ? T.bg : color}>{pad(` ${label}`, width)}</text>
    </box>
  );
}

const LABEL_W = 10;

function FormPanel({ form, width, height }: { form: Form; width: number; height: number }) {
  const box = Math.min(width, 72);
  const valueW = box - 4 - LABEL_W - 1;
  return (
    <box style={{ width, height, flexDirection: "column", backgroundColor: T.panel }}>
      <box
        title={FORM_TITLES[form.kind]}
        style={{
          width: box,
          // border 2 + padding 2 + fields + the hint/error line
          height: 4 + form.fields.length + 1,
          border: true,
          borderStyle: "rounded",
          borderColor: ACCENT,
          titleColor: ACCENT,
          padding: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        {form.fields.map((f, i) => {
          const active = i === form.focus;
          const shown = f.options ? `‹ ${f.value || "·"} ›` : f.value;
          return (
            <text key={f.name}>
              <span fg={T.dim}>{pad(f.label, LABEL_W)}</span>
              <span fg={active ? T.fg : T.dim}>{pad(shown, valueW)}</span>
              <span fg={active && !f.options ? ACCENT : T.panel}>▏</span>
            </text>
          );
        })}
        <text>
          {form.error ? <span fg={T.red}>{pad(`⚠ ${form.error}`, box - 4)}</span> : <span fg={T.dim}>{pad(FORM_HINTS[form.kind], box - 4)}</span>}
        </text>
      </box>
    </box>
  );
}

function StatusLine({
  width,
  busy,
  spin,
  flash,
  armed,
  vault,
  rows,
  topRow,
  visRows,
}: {
  width: number;
  busy: string | null;
  spin: string;
  flash: Flash | null;
  armed: KeyView | null;
  vault: Vault | null;
  rows: number;
  topRow: number;
  visRows: number;
}) {
  if (busy) return <text fg={T.yellow}>{pad(`${spin} ${busy}…`, width)}</text>;
  if (armed) {
    const provider: Provider | undefined = vault?.providers.find((p) => p.id === armed.providerId);
    const remote = armed.sharedWith.length
      ? `local only — the same value is live in ${armed.sharedWith.join(", ")}`
      : provider?.mint
        ? `revokes it on ${provider.name} when it can`
        : `${provider?.name ?? armed.providerId} has no revoke API — local only`;
    return <text fg={T.red}>{pad(`⚠ revoke ${armed.id} (${armed.providerId} · ${armed.project}) — ${remote} — x again`, width)}</text>;
  }
  if (flash) return <text fg={flash.color}>{pad(flash.text, width)}</text>;
  const range = rows > visRows ? `${topRow + 1}–${Math.min(rows, topRow + visRows)} of ${rows} rows · ` : "";
  return <text fg={T.dim}>{pad(`${range}DPAPI vault · ~/.destedtui/keys/vault.bin`, width)}</text>;
}
